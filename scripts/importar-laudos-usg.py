import argparse
import csv
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

import pdfplumber


DEFAULT_SOURCES = [
    r"C:\Users\ECOLINK\Desktop\Laudos-Ultrasom\Progrma-Agora-Tem-Especialistas",
    r"C:\Users\ECOLINK\Desktop\temp",
]
DEFAULT_STORAGE = r"C:\Vinicius\TRABALHO\storage\laudos-usg"
DEFAULT_BACKUP_DIR = r"C:\Vinicius\TRABALHO\backups"

SCHEMA_SQL = r"""
CREATE SCHEMA IF NOT EXISTS oci;

CREATE TABLE IF NOT EXISTS oci.laudos_pacientes (
    id bigserial PRIMARY KEY,
    paciente_id bigint NULL REFERENCES oci.pacientes(id),
    nome_extraido text NOT NULL,
    nome_normalizado text NOT NULL,
    cartao_sus text NULL,
    telefone text NULL,
    municipio_paciente text NULL,
    tipo_laudo text NULL,
    numero_exame text NULL,
    data_solicitacao date NULL,
    data_realizacao date NULL,
    arquivo_original text NOT NULL,
    caminho_origem text NOT NULL,
    caminho_armazenado text NOT NULL,
    sha256 text NOT NULL UNIQUE,
    chave_logica text NULL,
    duplicado_de_id bigint NULL REFERENCES oci.laudos_pacientes(id),
    status_vinculo text NOT NULL DEFAULT 'pendente',
    confianca_vinculo numeric NULL,
    erro_extracao text NULL,
    criado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE oci.laudos_pacientes
    ADD COLUMN IF NOT EXISTS procedimento_raw text,
    ADD COLUMN IF NOT EXISTS data_nascimento date,
    ADD COLUMN IF NOT EXISTS idade_texto text,
    ADD COLUMN IF NOT EXISTS idade_anos integer,
    ADD COLUMN IF NOT EXISTS origem_importacao text,
    ADD COLUMN IF NOT EXISTS vinculo_motivo text,
    ADD COLUMN IF NOT EXISTS registro_ativo boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS laudos_pacientes_cartao_sus_idx
    ON oci.laudos_pacientes (cartao_sus);
CREATE INDEX IF NOT EXISTS laudos_pacientes_nome_normalizado_idx
    ON oci.laudos_pacientes (nome_normalizado);
CREATE INDEX IF NOT EXISTS laudos_pacientes_paciente_id_idx
    ON oci.laudos_pacientes (paciente_id);
CREATE INDEX IF NOT EXISTS laudos_pacientes_chave_logica_idx
    ON oci.laudos_pacientes (chave_logica);
CREATE INDEX IF NOT EXISTS laudos_pacientes_status_vinculo_idx
    ON oci.laudos_pacientes (status_vinculo);
CREATE INDEX IF NOT EXISTS laudos_pacientes_tipo_laudo_idx
    ON oci.laudos_pacientes (tipo_laudo);
CREATE INDEX IF NOT EXISTS laudos_pacientes_data_nascimento_idx
    ON oci.laudos_pacientes (data_nascimento);
CREATE INDEX IF NOT EXISTS laudos_pacientes_origem_importacao_idx
    ON oci.laudos_pacientes (origem_importacao);
CREATE INDEX IF NOT EXISTS laudos_pacientes_registro_ativo_idx
    ON oci.laudos_pacientes (registro_ativo);
"""


@dataclass
class UsgRow:
    paciente_id: int | None
    nome_extraido: str
    nome_normalizado: str
    cartao_sus: str | None
    telefone: str | None
    municipio_paciente: str | None
    tipo_laudo: str
    numero_exame: str | None
    data_solicitacao: str | None
    data_realizacao: str | None
    arquivo_original: str
    caminho_origem: str
    caminho_armazenado: str
    sha256: str
    chave_logica: str | None
    status_vinculo: str
    confianca_vinculo: float | None
    erro_extracao: str | None
    procedimento_raw: str | None
    data_nascimento: str | None
    idade_texto: str | None
    idade_anos: int | None
    origem_importacao: str
    vinculo_motivo: str | None
    registro_ativo: bool
    source_mtime: float


def run_docker_psql(sql: str, args: argparse.Namespace, capture: bool = True) -> str:
    cmd = [
        "docker",
        "exec",
        "-i",
        args.container,
        "psql",
        "-U",
        args.db_user,
        "-d",
        args.db_name,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-X",
    ]
    proc = subprocess.run(
        cmd,
        input=sql,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql failed")
    return proc.stdout or ""


def query_csv(sql: str, args: argparse.Namespace) -> list[dict[str, str]]:
    output = run_docker_psql(f"COPY ({sql}) TO STDOUT WITH CSV HEADER;\n", args)
    return list(csv.DictReader(output.splitlines()))


def table_exists(args: argparse.Namespace) -> bool:
    rows = query_csv("SELECT to_regclass('oci.laudos_pacientes') IS NOT NULL AS exists", args)
    return bool(rows and rows[0].get("exists") == "t")


def load_existing(args: argparse.Namespace) -> set[str]:
    if not table_exists(args):
        return set()
    rows = query_csv("SELECT sha256 FROM oci.laudos_pacientes WHERE sha256 IS NOT NULL", args)
    return {row["sha256"] for row in rows if row.get("sha256")}


def load_patients(args: argparse.Namespace) -> dict[str, list[dict]]:
    rows = query_csv(
        "SELECT id, patient_key, nome_preferido FROM oci.pacientes WHERE patient_key IS NOT NULL",
        args,
    )
    patients: dict[str, list[dict]] = {}
    for row in rows:
        key = normalize_name(row["patient_key"])
        patients.setdefault(key, []).append(
            {
                "id": int(row["id"]),
                "patient_key": key,
                "nome_preferido": row["nome_preferido"],
            }
        )
    return patients


def backup_database(args: argparse.Namespace) -> Path:
    backup_dir = Path(args.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"ocis_local-before-usg-{stamp}.dump"
    cmd = [
        "docker",
        "exec",
        args.container,
        "pg_dump",
        "-U",
        args.db_user,
        "-d",
        args.db_name,
        "-Fc",
    ]
    with target.open("wb") as out:
        proc = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        target.unlink(missing_ok=True)
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip())
    return target


def normalize_spaces(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\xa0", " ")).strip()


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def normalize_name(value: str | None) -> str:
    value = strip_accents(normalize_spaces(value or "")).upper()
    value = value.replace("�", " ")
    value = re.sub(r"[^A-Z0-9 ]+", " ", value)
    return normalize_spaces(value)


def normalize_title(value: str | None) -> str:
    value = strip_accents(normalize_spaces(value or "")).upper()
    value = value.replace("�", " ")
    value = re.sub(r"[^A-Z0-9 /]+", " ", value)
    return normalize_spaces(value)


def parse_date(value: str | None) -> str | None:
    value = normalize_spaces(value)
    if not value:
        return None
    try:
        return dt.datetime.strptime(value, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return None


def parse_age(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"(\d{1,3})", value)
    if not match:
        return None
    age = int(match.group(1))
    return age if 0 <= age <= 130 else None


def search_group(pattern: str, text: str, flags: int = re.IGNORECASE) -> str | None:
    match = re.search(pattern, text, flags)
    if not match:
        return None
    return normalize_spaces(match.group(1))


def extract_text(pdf_path: Path, max_pages: int = 2) -> str:
    with pdfplumber.open(str(pdf_path)) as pdf:
        pages = pdf.pages[:max_pages]
        text = "\n".join(page.extract_text() or "" for page in pages)
    return normalize_spaces(text)


def title_from_text(text: str) -> str | None:
    patterns = [
        r"((?:LAUDO\s+DE\s+)?COMPLEMENTA\S*\s+MAMOGR\S*\s+POR\s+ULTRASSONOGRAFIA[^:]{0,80})",
        r"(LAUDO\s+DE\s+ULTRASSONOGRAFIA[^:]{0,130})",
        r"(ULTRASSONOGRAFIA\s*\(USG\)[^:]{0,100})",
    ]
    for pattern in patterns:
        title = search_group(pattern, text)
        if title:
            title = re.split(r"\bPaciente\s*:", title, flags=re.IGNORECASE)[0]
            return normalize_spaces(title)
    return None


def classify_usg(raw_title: str | None) -> str:
    title = normalize_title(raw_title)
    if "COMPLEMENT" in title and ("MAMA" in title or "MAMOGRAF" in title):
        return "USG_MAMA_COMPLEMENTACAO"
    if "TIREOIDE" in title or "AXILA" in title:
        return "USG_OUTRO_QUARENTENA"
    if "MAMA" in title or "MAMAR" in title or "MAMRIO" in title:
        return "USG_MAMA"
    if "TRANSVAGINAL" in title:
        return "USG_TRANSVAGINAL"
    if "PELV" in title:
        return "USG_PELVICO_FEMININO"
    return "USG_OUTRO_QUARENTENA"


def safe_storage_name(original_name: str, sha256: str) -> str:
    stem = strip_accents(Path(original_name).stem)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    stem = stem[:120] or "laudo-usg"
    return f"{sha256[:16]}_{stem}.pdf"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_source_root(path: Path, source_roots: list[Path]) -> str:
    for root in source_roots:
        try:
            path.relative_to(root)
            return str(root)
        except ValueError:
            continue
    return str(path.parent)


def extract_usg_fields(pdf_path: Path) -> tuple[dict, list[str]]:
    errors: list[str] = []
    text = extract_text(pdf_path)
    title = title_from_text(text)
    tipo = classify_usg(title)

    nome = search_group(
        r"Paciente\s*:\s*(.*?)(?=\s+Data\s+de\s+Nascimento\s*:|\s+Idade\s*:|\s+Data\s*:|\s+Descri\S*o\s+do\s+exame\s*:|$)",
        text,
    )
    data_nascimento = parse_date(
        search_group(r"Data\s+de\s+Nascimento\s*:\s*(\d{2}/\d{2}/\d{4})", text)
    )
    idade_texto = search_group(
        r"Idade\s*:\s*(.*?)(?=\s+Data\s+de\s+Nascimento\s*:|\s+Data\s*:|\s+Descri\S*o\s+do\s+exame\s*:|$)",
        text,
    )
    idade_anos = parse_age(idade_texto)
    data_laudo = parse_date(search_group(r"\bData\s*:\s*(\d{2}/\d{2}/\d{4})", text))

    if not title:
        errors.append("titulo ausente ou nao reconhecido")
    if not nome:
        errors.append("campo ausente: paciente")
    if not data_laudo:
        errors.append("campo ausente: data_laudo")
    return {
        "procedimento_raw": title,
        "tipo_laudo": tipo,
        "nome_extraido": nome or "",
        "nome_normalizado": normalize_name(nome),
        "data_nascimento": data_nascimento,
        "idade_texto": idade_texto,
        "idade_anos": idade_anos,
        "data_realizacao": data_laudo,
        "missing_identity": not data_nascimento and idade_anos is None,
    }, errors


def identity_key(row: UsgRow) -> str | None:
    if row.data_nascimento:
        return f"DN:{row.data_nascimento}"
    if row.idade_anos is not None:
        return f"IDADE:{row.idade_anos}"
    return None


def logical_key(fields: dict) -> str | None:
    name = fields.get("nome_normalizado")
    tipo = fields.get("tipo_laudo")
    data = fields.get("data_realizacao")
    identity = fields.get("data_nascimento") or (
        f"IDADE-{fields.get('idade_anos')}" if fields.get("idade_anos") is not None else None
    )
    if not (name and tipo and data and identity):
        return None
    return "|".join(["USG", tipo, name, data, str(identity)])


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def assign_links(rows: list[UsgRow], patient_map: dict[str, list[dict]], summary: dict) -> None:
    name_identities: dict[str, set[str]] = {}
    for row in rows:
        ident = identity_key(row)
        if ident:
            name_identities.setdefault(row.nome_normalizado, set()).add(ident)

    anchors: dict[tuple[str, str], int] = {}
    for row in rows:
        ident = identity_key(row)
        candidates = patient_map.get(row.nome_normalizado, [])
        if (
            row.tipo_laudo != "USG_OUTRO_QUARENTENA"
            and ident
            and len(candidates) == 1
            and len(name_identities.get(row.nome_normalizado, set())) == 1
        ):
            row.paciente_id = candidates[0]["id"]
            row.status_vinculo = "vinculado_auto"
            row.confianca_vinculo = 1.0
            row.vinculo_motivo = "nome_exato_com_identidade_sem_conflito"
            anchors[(row.nome_normalizado, ident)] = row.paciente_id
            summary["linked_exact_name"] += 1
        else:
            row.status_vinculo = "pendente_revisao"
            row.vinculo_motivo = "aguarda_revisao"

    patient_names = list(patient_map.keys())
    for row in rows:
        if row.paciente_id is not None or row.tipo_laudo == "USG_OUTRO_QUARENTENA":
            continue
        ident = identity_key(row)
        if not ident:
            row.vinculo_motivo = "sem_data_nascimento_ou_idade"
            continue

        exact_anchor = anchors.get((row.nome_normalizado, ident))
        if exact_anchor:
            row.paciente_id = exact_anchor
            row.status_vinculo = "vinculado_auto"
            row.confianca_vinculo = 0.99
            row.vinculo_motivo = "ancora_mesmo_nome_e_identidade"
            summary["linked_by_anchor"] += 1
            continue

        best = [
            (name, similarity(row.nome_normalizado, name))
            for name in patient_names
            if name != row.nome_normalizado
        ]
        best = [item for item in best if item[1] >= 0.9]
        best.sort(key=lambda item: item[1], reverse=True)
        anchor_matches = [
            (name, score, anchors[(name, ident)])
            for name, score in best
            if (name, ident) in anchors
        ]
        unique_patients = {item[2] for item in anchor_matches}
        if len(unique_patients) == 1:
            row.paciente_id = next(iter(unique_patients))
            row.status_vinculo = "vinculado_auto"
            row.confianca_vinculo = round(anchor_matches[0][1], 4)
            row.vinculo_motivo = "nome_parecido_com_ancora_e_identidade"
            summary["linked_similar_anchor"] += 1
        elif len(anchor_matches) > 1:
            row.vinculo_motivo = "multiplas_ancoras_similares"
        else:
            row.vinculo_motivo = "sem_ancora_compativel"

    for row in rows:
        if row.paciente_id is None:
            summary["pending_link"] += 1
        if row.tipo_laudo == "USG_OUTRO_QUARENTENA":
            row.status_vinculo = "pendente_revisao"
            row.vinculo_motivo = "tipo_fora_alvo_ou_titulo_indefinido"


def choose_active_duplicates(rows: list[UsgRow], summary: dict) -> None:
    groups: dict[str, list[UsgRow]] = {}
    for row in rows:
        if row.chave_logica:
            groups.setdefault(row.chave_logica, []).append(row)

    for grouped in groups.values():
        if len(grouped) <= 1:
            continue
        summary["logical_duplicate_groups"] += 1
        summary["logical_duplicates_detected"] += len(grouped) - 1
        keep = max(grouped, key=lambda row: (row.source_mtime, row.data_realizacao or "", row.caminho_origem))
        for row in grouped:
            if row is not keep:
                row.registro_ativo = False


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_insert_sql(rows: list[UsgRow]) -> str:
    columns = [
        "paciente_id",
        "nome_extraido",
        "nome_normalizado",
        "cartao_sus",
        "telefone",
        "municipio_paciente",
        "tipo_laudo",
        "numero_exame",
        "data_solicitacao",
        "data_realizacao",
        "arquivo_original",
        "caminho_origem",
        "caminho_armazenado",
        "sha256",
        "chave_logica",
        "status_vinculo",
        "confianca_vinculo",
        "erro_extracao",
        "procedimento_raw",
        "data_nascimento",
        "idade_texto",
        "idade_anos",
        "origem_importacao",
        "vinculo_motivo",
        "registro_ativo",
    ]
    values = []
    for row in rows:
        data = asdict(row)
        values.append("(" + ", ".join(sql_literal(data[col]) for col in columns) + ")")

    update_columns = [col for col in columns if col != "sha256"]
    updates = ",\n        ".join(f"{col} = EXCLUDED.{col}" for col in update_columns)
    return f"""
INSERT INTO oci.laudos_pacientes ({", ".join(columns)})
VALUES
{",\n".join(values)}
ON CONFLICT (sha256) DO UPDATE SET
        {updates};

WITH ranked AS (
    SELECT
        id,
        FIRST_VALUE(id) OVER (
            PARTITION BY chave_logica
            ORDER BY registro_ativo DESC, criado_em DESC, id DESC
        ) AS keep_id,
        COUNT(*) OVER (PARTITION BY chave_logica) AS total
    FROM oci.laudos_pacientes
    WHERE chave_logica IS NOT NULL
)
UPDATE oci.laudos_pacientes lp
SET duplicado_de_id = CASE
        WHEN ranked.total > 1 AND lp.id <> ranked.keep_id THEN ranked.keep_id
        ELSE NULL
    END,
    registro_ativo = CASE
        WHEN ranked.total > 1 THEN lp.id = ranked.keep_id
        ELSE lp.registro_ativo
    END
FROM ranked
WHERE lp.id = ranked.id;
"""


def collect_pdfs(sources: list[str]) -> list[Path]:
    files: list[Path] = []
    seen_paths = set()
    for source in sources:
        root = Path(source)
        if not root.exists():
            raise FileNotFoundError(f"Pasta de origem nao encontrada: {root}")
        for pdf in sorted(root.rglob("*.pdf")):
            key = str(pdf.resolve()).lower()
            if key not in seen_paths:
                seen_paths.add(key)
                files.append(pdf)
    return sorted(files, key=lambda item: str(item).lower())


def build_rows(args: argparse.Namespace) -> tuple[list[UsgRow], dict]:
    sources = args.source or DEFAULT_SOURCES
    source_roots = [Path(source) for source in sources]
    storage = Path(args.storage)
    pdfs = collect_pdfs(sources)
    patient_map = load_patients(args)
    existing_shas = load_existing(args)
    seen_shas = set(existing_shas)
    rows: list[UsgRow] = []

    summary = {
        "sources": sources,
        "storage": str(storage),
        "total_pdf_paths": len(pdfs),
        "prepared_rows": 0,
        "existing_sha_skipped": 0,
        "exact_sha_duplicates_in_source": 0,
        "logical_duplicates_detected": 0,
        "logical_duplicate_groups": 0,
        "linked_exact_name": 0,
        "linked_by_anchor": 0,
        "linked_similar_anchor": 0,
        "pending_link": 0,
        "with_nome": 0,
        "with_data_nascimento": 0,
        "with_idade_anos": 0,
        "with_data_laudo": 0,
        "missing_identity": 0,
        "with_error": 0,
        "quarantined": 0,
        "ignored_non_laudo": 0,
        "active_rows": 0,
        "inactive_duplicate_rows": 0,
        "by_tipo_laudo": {},
        "ignored_sample": [],
        "errors_sample": [],
    }

    for index, pdf_path in enumerate(pdfs, start=1):
        if args.progress_every and (index == 1 or index % args.progress_every == 0):
            print(
                f"Processando USG {index}/{len(pdfs)}: {pdf_path.name}",
                file=sys.stderr,
                flush=True,
            )
        sha = file_sha256(pdf_path)
        if sha in existing_shas:
            summary["existing_sha_skipped"] += 1
            continue
        if sha in seen_shas:
            summary["exact_sha_duplicates_in_source"] += 1
            continue
        seen_shas.add(sha)

        errors: list[str]
        try:
            fields, errors = extract_usg_fields(pdf_path)
        except Exception as exc:
            fields = {
                "procedimento_raw": None,
                "tipo_laudo": "USG_OUTRO_QUARENTENA",
                "nome_extraido": "",
                "nome_normalizado": "",
                "data_nascimento": None,
                "idade_texto": None,
                "idade_anos": None,
                "data_realizacao": None,
            }
            errors = [f"erro ao extrair PDF: {type(exc).__name__}: {exc}"]

        if fields["tipo_laudo"] == "USG_OUTRO_QUARENTENA":
            summary["quarantined"] += 1
        if not fields["procedimento_raw"] and not fields["nome_extraido"] and not fields["data_realizacao"]:
            summary["ignored_non_laudo"] += 1
            summary["quarantined"] -= 1
            if len(summary["ignored_sample"]) < 20:
                summary["ignored_sample"].append(str(pdf_path))
            continue
        if errors:
            summary["with_error"] += 1
            if len(summary["errors_sample"]) < 30:
                summary["errors_sample"].append({"arquivo": str(pdf_path), "erros": errors})
        if fields["nome_extraido"]:
            summary["with_nome"] += 1
        if fields["data_nascimento"]:
            summary["with_data_nascimento"] += 1
        if fields["idade_anos"] is not None:
            summary["with_idade_anos"] += 1
        if fields["data_realizacao"]:
            summary["with_data_laudo"] += 1
        if fields["missing_identity"]:
            summary["missing_identity"] += 1

        summary["by_tipo_laudo"][fields["tipo_laudo"]] = (
            summary["by_tipo_laudo"].get(fields["tipo_laudo"], 0) + 1
        )

        stored = storage / safe_storage_name(pdf_path.name, sha)
        rows.append(
            UsgRow(
                paciente_id=None,
                nome_extraido=fields["nome_extraido"] or "",
                nome_normalizado=fields["nome_normalizado"] or "",
                cartao_sus=None,
                telefone=None,
                municipio_paciente=None,
                tipo_laudo=fields["tipo_laudo"],
                numero_exame=None,
                data_solicitacao=None,
                data_realizacao=fields["data_realizacao"],
                arquivo_original=pdf_path.name,
                caminho_origem=str(pdf_path),
                caminho_armazenado=str(stored),
                sha256=sha,
                chave_logica=logical_key(fields),
                status_vinculo="pendente_revisao",
                confianca_vinculo=None,
                erro_extracao="; ".join(errors) if errors else None,
                procedimento_raw=fields["procedimento_raw"],
                data_nascimento=fields["data_nascimento"],
                idade_texto=fields["idade_texto"],
                idade_anos=fields["idade_anos"],
                origem_importacao="USG",
                vinculo_motivo=None,
                registro_ativo=True,
                source_mtime=pdf_path.stat().st_mtime,
            )
        )

    assign_links(rows, patient_map, summary)
    choose_active_duplicates(rows, summary)
    summary["active_rows"] = sum(1 for row in rows if row.registro_ativo)
    summary["inactive_duplicate_rows"] = sum(1 for row in rows if not row.registro_ativo)
    summary["prepared_rows"] = len(rows)
    return rows, summary


def write_report(args: argparse.Namespace, summary: dict, mode: str) -> Path:
    reports_dir = Path(args.storage) / "_import_reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = reports_dir / f"{mode}-{stamp}.json"
    report_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    return report_path


def copy_files(rows: list[UsgRow]) -> None:
    for row in rows:
        source = Path(row.caminho_origem)
        target = Path(row.caminho_armazenado)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)


def print_summary(summary: dict) -> None:
    print(json.dumps(summary, indent=2, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Importa laudos PDF de USG para o PostgreSQL Docker."
    )
    parser.add_argument("--source", action="append", help="Pasta raiz de PDFs. Pode repetir.")
    parser.add_argument("--storage", default=DEFAULT_STORAGE)
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--container", default="oci_postgres_local")
    parser.add_argument("--db-name", default="ocis_local")
    parser.add_argument("--db-user", default="oci_admin")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--migrate-only", action="store_true")
    parser.add_argument("--progress-every", type=int, default=250)
    args = parser.parse_args()
    actions = [args.dry_run, args.commit, args.migrate_only]
    if sum(bool(action) for action in actions) != 1:
        parser.error("Use exatamente uma acao: --dry-run, --commit ou --migrate-only.")
    return args


def main() -> int:
    args = parse_args()

    if args.migrate_only:
        run_docker_psql(SCHEMA_SQL, args, capture=False)
        print("Schema oci.laudos_pacientes verificado/criado para USG.")
        return 0

    rows, summary = build_rows(args)

    if args.dry_run:
        report = write_report(args, summary, "dry-run-usg")
        summary["report_path"] = str(report)
        print_summary(summary)
        return 0

    if not args.no_backup:
        backup_path = backup_database(args)
        summary["backup_path"] = str(backup_path)

    run_docker_psql(SCHEMA_SQL, args, capture=False)
    copy_files(rows)
    if rows:
        run_docker_psql(build_insert_sql(rows), args, capture=False)

    validation = query_csv(
        """
        SELECT
            COUNT(*)::int AS total_geral,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG')::int AS total_usg,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG' AND paciente_id IS NOT NULL)::int AS usg_vinculados,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG' AND paciente_id IS NULL)::int AS usg_pendentes,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG' AND registro_ativo)::int AS usg_ativos,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG' AND NOT registro_ativo)::int AS usg_duplicados_inativos,
            COUNT(*) FILTER (WHERE origem_importacao = 'USG' AND erro_extracao IS NOT NULL)::int AS usg_erros
        FROM oci.laudos_pacientes
        """,
        args,
    )
    summary["post_import_validation"] = validation[0] if validation else {}
    report = write_report(args, summary, "commit-usg")
    summary["report_path"] = str(report)
    print_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
