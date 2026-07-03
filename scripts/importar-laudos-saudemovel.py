import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path

import pdfplumber


DEFAULT_SOURCE = r"C:\Users\ECOLINK\Downloads\saudemovel"
DEFAULT_STORAGE = r"C:\Vinicius\TRABALHO\storage\laudos-saudemovel"
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
"""


@dataclass
class LaudoRow:
    paciente_id: int | None
    nome_extraido: str
    nome_normalizado: str
    cartao_sus: str | None
    telefone: str | None
    municipio_paciente: str | None
    tipo_laudo: str | None
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
    copy_sql = f"COPY ({sql}) TO STDOUT WITH CSV HEADER;\n"
    output = run_docker_psql(copy_sql, args)
    return list(csv.DictReader(output.splitlines()))


def table_exists(args: argparse.Namespace) -> bool:
    rows = query_csv(
        "SELECT to_regclass('oci.laudos_pacientes') IS NOT NULL AS exists",
        args,
    )
    return bool(rows and rows[0].get("exists") == "t")


def load_patient_map(args: argparse.Namespace) -> dict[str, int]:
    rows = query_csv(
        "SELECT id, patient_key FROM oci.pacientes WHERE patient_key IS NOT NULL",
        args,
    )
    return {normalize_name(row["patient_key"]): int(row["id"]) for row in rows}


def load_existing(args: argparse.Namespace) -> tuple[set[str], dict[str, int]]:
    if not table_exists(args):
        return set(), {}
    rows = query_csv(
        """
        SELECT id, sha256, chave_logica
        FROM oci.laudos_pacientes
        """,
        args,
    )
    sha_seen = set()
    logical_first: dict[str, int] = {}
    for row in rows:
        if row.get("sha256"):
            sha_seen.add(row["sha256"])
        key = row.get("chave_logica")
        if key and key not in logical_first:
            logical_first[key] = int(row["id"])
    return sha_seen, logical_first


def backup_database(args: argparse.Namespace) -> Path:
    backup_dir = Path(args.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"ocis_local-before-laudos-{stamp}.dump"
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
    value = re.sub(r"[^A-Z0-9 ]+", " ", value)
    return normalize_spaces(value)


def normalize_type(value: str | None) -> str | None:
    normalized = normalize_name(value)
    return normalized or None


def safe_storage_name(original_name: str, sha256: str) -> str:
    stem = Path(original_name).stem
    stem = strip_accents(stem)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    stem = stem[:120] or "laudo"
    return f"{sha256[:16]}_{stem}.pdf"


def parse_date(value: str | None) -> str | None:
    value = normalize_spaces(value)
    if not value:
        return None
    try:
        return dt.datetime.strptime(value, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return None


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


def extract_fields(pdf_path: Path) -> tuple[dict[str, str | None], list[str]]:
    errors: list[str] = []
    text = extract_text(pdf_path)

    tipo = search_group(r"^\s*([A-ZÇÃÕÁÉÍÓÚÂÊÔ ]{4,80})\s+CNES\s*:", text)
    numero_exame = search_group(r"N\S{0,3}\s*do\s*Exame\s*:\s*([0-9]+)", text)
    data_solicitacao = parse_date(
        search_group(r"Data\s+da\s+solicita\S*o\s*:\s*(\d{2}/\d{2}/\d{4})", text)
    )
    data_realizacao = parse_date(
        search_group(r"Data\s+da\s+realiza\S*o\s*:\s*(\d{2}/\d{2}/\d{4})", text)
    )
    cartao_sus = search_group(r"Cart\S*o\s*SUS\s*:\s*([0-9][0-9\s.\-]{4,30})", text)
    nome = search_group(
        r"NOME\s*:\s*(.*?)(?=\s+Sexo\s*:|\s+Nascimento\s*:|\s+Idade\s*:|$)",
        text,
    )
    telefone = search_group(
        r"Telefone\s*:\s*(.*?)(?=\s+M.{0,3}e\s*:|\s+Endere\S*o\s*:|$)",
        text,
    )
    municipio = search_group(
        r"Endere\S*o\s*:.*?\bMunic\S*pio\s*:\s*(.*?)(?=\s+UF\s*:|\s+CEP\s*:|\s+Unidade\s+Movel|$)",
        text,
    )

    if cartao_sus:
        digits = re.sub(r"\D+", "", cartao_sus)
        cartao_sus = digits or None
    if telefone:
        telefone = normalize_spaces(telefone)
    if municipio:
        municipio = normalize_spaces(municipio).upper()

    required = {
        "nome": nome,
        "cartao_sus": cartao_sus,
        "numero_exame": numero_exame,
    }
    for key, value in required.items():
        if not value:
            errors.append(f"campo ausente: {key}")

    return {
        "tipo_laudo": normalize_type(tipo),
        "numero_exame": numero_exame,
        "data_solicitacao": data_solicitacao,
        "data_realizacao": data_realizacao,
        "cartao_sus": cartao_sus,
        "nome_extraido": nome or "",
        "nome_normalizado": normalize_name(nome),
        "telefone": telefone,
        "municipio_paciente": municipio,
    }, errors


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def logical_key(fields: dict[str, str | None]) -> str | None:
    if not (
        fields.get("cartao_sus")
        and fields.get("numero_exame")
        and fields.get("tipo_laudo")
        and fields.get("data_realizacao")
    ):
        return None
    return "|".join(
        [
            fields["cartao_sus"] or "",
            fields["numero_exame"] or "",
            fields["tipo_laudo"] or "",
            fields["data_realizacao"] or "",
        ]
    )


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_insert_sql(rows: list[LaudoRow]) -> str:
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
    ]
    values = []
    for row in rows:
        data = asdict(row)
        values.append("(" + ", ".join(sql_literal(data[col]) for col in columns) + ")")

    update_columns = [
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
        "chave_logica",
        "status_vinculo",
        "confianca_vinculo",
        "erro_extracao",
    ]
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
        MIN(id) OVER (PARTITION BY chave_logica) AS first_id,
        COUNT(*) OVER (PARTITION BY chave_logica) AS total
    FROM oci.laudos_pacientes
    WHERE chave_logica IS NOT NULL
)
UPDATE oci.laudos_pacientes lp
SET duplicado_de_id = CASE
    WHEN ranked.total > 1 AND lp.id <> ranked.first_id THEN ranked.first_id
    ELSE NULL
END
FROM ranked
WHERE lp.id = ranked.id;
"""


def build_rows(args: argparse.Namespace) -> tuple[list[LaudoRow], dict]:
    source = Path(args.source)
    storage = Path(args.storage)
    if not source.exists():
        raise FileNotFoundError(f"Pasta de origem nao encontrada: {source}")

    patient_map = load_patient_map(args)
    existing_shas, existing_logical = load_existing(args)
    pdfs = sorted(source.glob("*.pdf"))
    rows: list[LaudoRow] = []
    seen_shas = set(existing_shas)
    seen_logical = dict(existing_logical)

    summary = {
        "source": str(source),
        "storage": str(storage),
        "total_pdfs": len(pdfs),
        "prepared_rows": 0,
        "existing_sha_skipped": 0,
        "exact_sha_duplicates_in_source": 0,
        "logical_duplicates_detected": 0,
        "linked_exact_name": 0,
        "pending_link": 0,
        "with_nome": 0,
        "with_cartao_sus": 0,
        "with_telefone": 0,
        "with_municipio_paciente": 0,
        "with_error": 0,
        "errors_sample": [],
    }

    for index, pdf_path in enumerate(pdfs, start=1):
        if args.progress_every and (index == 1 or index % args.progress_every == 0):
            print(
                f"Processando PDF {index}/{len(pdfs)}: {pdf_path.name}",
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

        try:
            fields, errors = extract_fields(pdf_path)
        except Exception as exc:
            fields = {
                "tipo_laudo": None,
                "numero_exame": None,
                "data_solicitacao": None,
                "data_realizacao": None,
                "cartao_sus": None,
                "nome_extraido": "",
                "nome_normalizado": "",
                "telefone": None,
                "municipio_paciente": None,
            }
            errors = [f"erro ao extrair PDF: {type(exc).__name__}: {exc}"]

        key = logical_key(fields)
        if key:
            if key in seen_logical:
                summary["logical_duplicates_detected"] += 1
            else:
                seen_logical[key] = -index

        paciente_id = patient_map.get(fields["nome_normalizado"] or "")
        if paciente_id:
            status = "vinculado_auto"
            confidence = 1.0
            summary["linked_exact_name"] += 1
        else:
            status = "pendente"
            confidence = None
            summary["pending_link"] += 1

        if errors:
            summary["with_error"] += 1
            if len(summary["errors_sample"]) < 20:
                summary["errors_sample"].append(
                    {"arquivo": pdf_path.name, "erros": errors}
                )

        if fields["nome_extraido"]:
            summary["with_nome"] += 1
        if fields["cartao_sus"]:
            summary["with_cartao_sus"] += 1
        if fields["telefone"]:
            summary["with_telefone"] += 1
        if fields["municipio_paciente"]:
            summary["with_municipio_paciente"] += 1

        stored = storage / safe_storage_name(pdf_path.name, sha)
        rows.append(
            LaudoRow(
                paciente_id=paciente_id,
                nome_extraido=fields["nome_extraido"] or "",
                nome_normalizado=fields["nome_normalizado"] or "",
                cartao_sus=fields["cartao_sus"],
                telefone=fields["telefone"],
                municipio_paciente=fields["municipio_paciente"],
                tipo_laudo=fields["tipo_laudo"],
                numero_exame=fields["numero_exame"],
                data_solicitacao=fields["data_solicitacao"],
                data_realizacao=fields["data_realizacao"],
                arquivo_original=pdf_path.name,
                caminho_origem=str(pdf_path),
                caminho_armazenado=str(stored),
                sha256=sha,
                chave_logica=key,
                status_vinculo=status,
                confianca_vinculo=confidence,
                erro_extracao="; ".join(errors) if errors else None,
            )
        )

    summary["prepared_rows"] = len(rows)
    return rows, summary


def write_report(args: argparse.Namespace, summary: dict, mode: str) -> Path:
    reports_dir = Path(args.storage) / "_import_reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = reports_dir / f"{mode}-{stamp}.json"
    report_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return report_path


def copy_files(rows: list[LaudoRow]) -> None:
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
        description="Importa laudos PDF do Saude Movel para o PostgreSQL Docker."
    )
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--storage", default=DEFAULT_STORAGE)
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--container", default="oci_postgres_local")
    parser.add_argument("--db-name", default="ocis_local")
    parser.add_argument("--db-user", default="oci_admin")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--migrate-only", action="store_true")
    parser.add_argument("--progress-every", type=int, default=100)
    args = parser.parse_args()

    actions = [args.dry_run, args.commit, args.migrate_only]
    if sum(bool(action) for action in actions) != 1:
        parser.error("Use exatamente uma acao: --dry-run, --commit ou --migrate-only.")
    return args


def main() -> int:
    args = parse_args()

    if args.migrate_only:
        run_docker_psql(SCHEMA_SQL, args, capture=False)
        print("Schema oci.laudos_pacientes verificado/criado.")
        return 0

    rows, summary = build_rows(args)

    if args.dry_run:
        report = write_report(args, summary, "dry-run")
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
            COUNT(*)::int AS total_importado,
            COUNT(*) FILTER (WHERE paciente_id IS NOT NULL)::int AS vinculados,
            COUNT(*) FILTER (WHERE paciente_id IS NULL)::int AS pendentes,
            COUNT(*) FILTER (WHERE duplicado_de_id IS NOT NULL)::int AS duplicados_logicos,
            COUNT(*) FILTER (WHERE erro_extracao IS NOT NULL)::int AS com_erro_extracao
        FROM oci.laudos_pacientes
        """,
        args,
    )
    summary["post_import_validation"] = validation[0] if validation else {}
    report = write_report(args, summary, "commit")
    summary["report_path"] = str(report)
    print_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
