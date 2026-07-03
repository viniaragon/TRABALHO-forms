# Fases 0-1 do pipeline de laudos: inventário, cofre imutável e extração de campos.
#
# Varre as fontes de PDFs (mamografia saudemovel + USG), calcula sha256, copia
# cada arquivo para storage/laudos/<sha256>.pdf (originais nunca são alterados)
# e extrai os campos do cabeçalho para um NDJSON consumido por
# scripts/carregar-laudos-banco.mjs.
#
# Uso:
#   py scripts/extrair-laudos-pdf.py [--saida reports/laudos-extraidos.ndjson]

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path

import fitz  # PyMuPDF

FONTES = [
    {"fonte": "SAUDEMOVEL", "root": Path(r"C:\Users\ECOLINK\Downloads\saudemovel")},
    {"fonte": "USG", "root": Path(r"C:\Users\ECOLINK\Desktop\Laudos-Ultrasom\Progrma-Agora-Tem-Especialistas")},
    {"fonte": "USG", "root": Path(r"C:\Users\ECOLINK\Desktop\temp")},
]
STORAGE = Path(r"C:\Vinicius\TRABALHO\storage\laudos")
IGNORAR_PASTAS = {"node_modules", "gerenciador-laudos", ".git"}


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def clean(value: str | None) -> str:
    if not value:
        return ""
    text = strip_accents(str(value))
    text = re.sub(r"[^\x20-\x7E]", " ", text)
    return re.sub(r"\s+", " ", text).strip().upper()


def parse_date_br(value: str | None, ano_min: int = 1900, ano_max: int = 2100) -> str | None:
    if not value:
        return None
    m = re.search(r"(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})", value)
    if not m:
        return None
    d, mth, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (ano_min <= y <= ano_max):
        return None
    try:
        return dt.date(y, mth, d).isoformat()
    except ValueError:
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def search(pattern: str, text: str, flags=re.IGNORECASE) -> str | None:
    m = re.search(pattern, text, flags)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


# ---------------------------------------------------------------------------
# Extração por tipo de fonte
# ---------------------------------------------------------------------------

def extract_mamografia(text: str) -> tuple[dict, list[str]]:
    """Laudos do saudemovel: cabeçalho rico (SUS, nascimento, telefone...)."""
    erros = []
    t = strip_accents(text)
    nome = search(r"NOME\s*:\s*(.*?)(?=\s+Sexo\s*:|\s+Nascimento\s*:|\s+Idade\s*:|$)", t)
    cartao = search(r"Carta?o\s*SUS\s*:\s*([0-9][0-9\s.\-]{4,30})", t)
    campos = {
        "tipo_laudo": "MAMOGRAFIA",
        "nome_extraido": nome or "",
        "cartao_sus": re.sub(r"\D+", "", cartao) or None if cartao else None,
        "numero_exame": search(r"N.{0,3}\s*do\s*Exame\s*:\s*([0-9]+)", t),
        "data_solicitacao": parse_date_br(search(r"Data\s+da\s+solicitac\S*o\s*:\s*(\d{2}/\d{2}/\d{4})", t), 2025, 2027),
        "data_realizacao": parse_date_br(search(r"Data\s+da\s+realizac\S*o\s*:\s*(\d{2}/\d{2}/\d{4})", t), 2025, 2027),
        "data_nascimento": parse_date_br(search(r"Nascimento\s*:\s*(\d{2}/\d{2}/\d{4})", t), 1920, 2015),
        "idade_anos": None,
        "telefone": search(r"Telefone\s*:\s*(.*?)(?=\s+M.{0,3}e\s*:|\s+Endere\S*o\s*:|$)", t),
        "municipio_paciente": clean(search(r"Endere\S*o\s*:.*?\bMunic\S*pio\s*:\s*(.*?)(?=\s+UF\s*:|\s+CEP\s*:|\s+Unidade\s+Movel|$)", t, re.IGNORECASE | re.DOTALL)) or None,
    }
    idade = search(r"Idade\s*:\s*(\d{1,3})", t)
    campos["idade_anos"] = int(idade) if idade else None
    for campo in ("nome_extraido", "cartao_sus", "numero_exame"):
        if not campos[campo]:
            erros.append(f"campo ausente: {campo}")
    return campos, erros


def classify_usg(titulo: str) -> str:
    """Classifica pelo cabeçalho do laudo (tudo antes de "Paciente:").

    Variantes reais encontradas: LAUDO DE ULTRASSONOGRAFIA DAS MAMAS / MAMARIO /
    MAMRIO, (LAUDO DE) COMPLEMENTACAO MAMOGRAFICA POR ULTRASSONOGRAFIA,
    TRANSVAGINAL / PELVICA (exame combinado), PELVICA (TRANSVAGINAL),
    ULTRASSONOGRAFIA PELVICA GINECOLOGICA, e fora do escopo: AXILAS, TIREOIDE,
    ABDOMEN, atestados e documentos administrativos.
    """
    t = clean(titulo)
    tem_usg = "ULTRASSONOGRAF" in t
    tem_tv = "TRANSVAGINAL" in t
    tem_pelv = "PELV" in t
    if "COMPLEMENTACAO MAMOGRAFICA" in t or ("COMPLEMENT" in t and re.search(r"MAM", t) and tem_usg):
        return "USG_MAMA_COMPLEMENTACAO"
    if not tem_usg:
        return "QUARENTENA_OUTRO"
    if "AXILA" in t or "TIREOIDE" in t or "ABDOMEN" in t:
        return "QUARENTENA_OUTRO"
    if tem_tv and tem_pelv:
        return "USG_TRANSVAGINAL_PELVICA"
    if tem_tv:
        return "USG_TRANSVAGINAL"
    if tem_pelv:
        return "USG_PELVICA"
    if re.search(r"MAM", t):  # MAMAS, MAMA, MAMARIO, MAMRIO...
        return "USG_MAMA"
    return "QUARENTENA_OUTRO"


def extract_usg(text: str) -> tuple[dict, list[str]]:
    """Laudos de USG: título + Paciente/Nascimento/Idade/Data no topo."""
    erros = []
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in strip_accents(text).split("\n")]
    lines = [ln for ln in lines if ln]

    # Cabeçalho = tudo antes da linha "Paciente:" (títulos podem quebrar em
    # 2 linhas e nem sempre começam com "LAUDO DE ULTRASSONOGRAFIA").
    titulo = None
    header_parts = []
    for ln in lines[:6]:
        if re.match(r"(?i)paciente\s*:", ln):
            break
        if re.fullmatch(r"\d{1,3}", ln):  # número de página solto
            continue
        header_parts.append(ln)
    if header_parts:
        titulo = " ".join(header_parts).strip()

    nome = nascimento = idade = data = None
    for ln in lines[:14]:
        if nome is None:
            m = re.match(r"(?i)paciente\s*:\s*(.+)", ln)
            if m:
                nome = m.group(1).strip()
                # nascimento embutido no nome: "JUCILEIDE NOGUEIRA 20/07/1984"
                d = re.search(r"[\s\-–]*(\d{1,2}/\d{1,2}/\d{4})\s*$", nome)
                if d:
                    nascimento = nascimento or parse_date_br(d.group(1), 1920, 2015)
                    nome = nome[:d.start()].strip(" -–")
                continue
        if nascimento is None:
            m = re.match(r"(?i)data\s+de\s+nascimento\s*:\s*(.+)", ln)
            if m:
                nascimento = parse_date_br(m.group(1), 1920, 2015)
                continue
        if idade is None:
            m = re.match(r"(?i)idade\s*:\s*(\d{1,3})", ln)
            if m:
                idade = int(m.group(1))
                continue
        if data is None:
            m = re.match(r"(?i)data\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", ln)
            if m:
                # janela de sanidade: laudos do programa são de 2025 em diante
                data = parse_date_br(m.group(1), 2025, 2027)

    campos = {
        "tipo_laudo": classify_usg(titulo or ""),
        "titulo_raw": titulo,
        "nome_extraido": nome or "",
        "cartao_sus": None,
        "numero_exame": None,
        "data_solicitacao": None,
        "data_realizacao": data,
        "data_nascimento": nascimento,
        "idade_anos": idade,
        "telefone": None,
        "municipio_paciente": None,
    }
    if not nome:
        erros.append("campo ausente: nome_extraido")
    if not data:
        erros.append("campo ausente: data_realizacao (Data:)")
    if titulo is None:
        erros.append("titulo nao encontrado")
    if nascimento is None and idade is None:
        erros.append("sem identidade (nascimento e idade ausentes)")
    return campos, erros


# ---------------------------------------------------------------------------
# Contexto da pasta (região/data) e varredura
# ---------------------------------------------------------------------------

def folder_context(path: Path) -> dict:
    partes = [clean(p) for p in path.parts]
    regiao = None
    for p in partes:
        if p in ("IRECE", "JACOBINA", "VALENCA"):
            regiao = p
    data_pasta = None
    for p in reversed(path.parent.parts):
        d = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", p)
        if d:
            data_pasta = parse_date_br(f"{d.group(1)}/{d.group(2)}/{d.group(3)}")
            break
    return {
        "regiao_pasta": regiao,
        "data_pasta": data_pasta,
        "em_pasta_duplicados": any("_DUPLICADOS" in p for p in partes),
    }


def iter_pdfs():
    vistos = set()
    for cfg in FONTES:
        root = cfg["root"]
        if not root.exists():
            print(f"AVISO: fonte inexistente: {root}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d.lower() not in IGNORAR_PASTAS]
            for fn in filenames:
                if not fn.lower().endswith(".pdf"):
                    continue
                p = Path(dirpath) / fn
                key = str(p).lower()
                if key in vistos:
                    continue
                vistos.add(key)
                yield cfg["fonte"], root, p


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--saida", default=r"reports\laudos-extraidos.ndjson")
    args = parser.parse_args()

    STORAGE.mkdir(parents=True, exist_ok=True)
    saida = Path(args.saida)
    saida.parent.mkdir(parents=True, exist_ok=True)

    total = por_fonte = {}
    stats = {"total": 0, "copiados": 0, "ja_no_cofre": 0, "erros_leitura": 0, "sem_texto": 0}
    with saida.open("w", encoding="utf-8") as out:
        for fonte, root, pdf in iter_pdfs():
            stats["total"] += 1
            if stats["total"] % 500 == 0:
                print(f"  ... {stats['total']} processados")
            rec = {
                "fonte": fonte,
                "caminho_origem": str(pdf),
                "arquivo_original": pdf.name,
                "arquivo_mtime": dt.datetime.fromtimestamp(pdf.stat().st_mtime).isoformat(),
                **folder_context(pdf.relative_to(root.parent)),
            }
            try:
                rec["sha256"] = sha256_file(pdf)
                destino = STORAGE / f"{rec['sha256']}.pdf"
                if destino.exists():
                    stats["ja_no_cofre"] += 1
                else:
                    shutil.copy2(pdf, destino)
                    stats["copiados"] += 1
                rec["caminho_armazenado"] = str(destino)

                doc = fitz.open(pdf)
                rec["paginas"] = doc.page_count
                text = "\n".join(doc[i].get_text() for i in range(min(2, doc.page_count)))
                doc.close()
                if not text.strip():
                    stats["sem_texto"] += 1
                    rec["erro_extracao"] = "pdf sem texto (imagem? requer OCR)"
                    rec["campos"] = None
                else:
                    extractor = extract_mamografia if fonte == "SAUDEMOVEL" else extract_usg
                    campos, erros = extractor(text)
                    campos["nome_normalizado"] = clean(campos["nome_extraido"])
                    rec["campos"] = campos
                    rec["erro_extracao"] = "; ".join(erros) if erros else None
            except Exception as exc:  # arquivo corrompido etc.
                stats["erros_leitura"] += 1
                rec["erro_extracao"] = f"falha de leitura: {exc}"
                rec["campos"] = None
                rec.setdefault("sha256", None)
                rec.setdefault("caminho_armazenado", None)
                rec.setdefault("paginas", None)
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(json.dumps(stats, indent=2))
    print(f"NDJSON: {saida}")


if __name__ == "__main__":
    main()
