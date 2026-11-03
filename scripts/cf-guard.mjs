#!/usr/bin/env node
/**
 * Impede que valores de `.env` cheguem ao Worker publicado.
 *
 * O `opennextjs-cloudflare build` lê .env, .env.local e variantes da pasta do
 * projeto (compile-env-files.js) e grava tudo em .open-next/cloudflare/next-env.mjs,
 * que o init.js importa e o wrangler empacota. Nada disso avisa: sem esta guarda,
 * a senha do banco iria em texto puro dentro do bundle.
 *
 *   preflight  antes do build: recusa arquivos .env com variáveis privadas.
 *   verify     depois do build e antes de TODO deploy (build.command do
 *              wrangler.jsonc): recusa um artefato com variáveis ou segredos.
 *
 * Nunca imprime valores: só o nome da variável, o arquivo e o tipo do achado.
 * Sai com código 1 ao encontrar qualquer problema.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Variáveis que podem constar em next-env: não são segredo e o Worker não depende delas ali. */
const ALLOWED_VARIABLES = new Set(["SESSION_TTL_HOURS"]);

/** Os mesmos arquivos lidos por extract-project-env-vars.js, nos três modos do OpenNext. */
const ENV_FILES = [".env", ".env.local", ...["production", "development", "test"].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];

const SECRET_PATTERNS = [
  ["connection string com senha", /postgres(?:ql)?:\/\/[^\s"'`:@/<>]+:[^\s"'`@/<>]+@[^\s"'`/<>]+/],
  ["host do pooler do Supabase", /[\w.-]+\.pooler\.supabase\.(?:com|co)/],
  ["chave da API do Supabase", /\bsb_secret_[\w-]{16,}|\bsbp_[a-f0-9]{32,}/],
  ["SEED_PASSWORD atribuída", /SEED_PASSWORD["']?\s*[:=]\s*["'`]?[^\s"'`,}]+/],
];

const MIN_LITERAL_LENGTH = 6;

function parseEnvFile(file) {
  const entries = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (match) entries.push([match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]);
  }
  return entries;
}

/** Valores privados dos .env da pasta, para procurá-los literalmente no artefato. */
function privateLiterals(root) {
  const literals = [];
  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of parseEnvFile(file)) {
      if (ALLOWED_VARIABLES.has(key) || value.length < MIN_LITERAL_LENGTH) continue;
      literals.push({ label: `valor de ${key} (${name})`, value });
      try {
        const password = new URL(value).password;
        if (password) literals.push({ label: `senha em ${key} (${name})`, value: decodeURIComponent(password) });
      } catch {
        // não é URL
      }
    }
  }
  return literals;
}

function preflight(root) {
  const problems = [];
  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const blocked = parseEnvFile(file).filter(([key, value]) => value !== "" && !ALLOWED_VARIABLES.has(key)).map(([key]) => key);
    if (blocked.length > 0) problems.push(`${name}: ${blocked.join(", ")}`);
  }
  return problems.length === 0
    ? []
    : [
        "Arquivos .env com variáveis privadas nesta pasta. O build do OpenNext as embutiria no Worker:",
        ...problems.map((problem) => `  - ${problem}`),
        "Compile numa cópia limpa, sem .env (docs/DEPLOY_CLOUDFLARE.md, seção 4).",
      ];
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function nextEnvVariables(file) {
  const found = new Set();
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/export const (\w+) = (\{.*\});/g)) {
    for (const key of Object.keys(JSON.parse(match[2]))) found.add(key);
  }
  return [...found];
}

function verify(root) {
  const output = path.join(root, ".open-next");
  const problems = [];
  const nextEnv = path.join(output, "cloudflare", "next-env.mjs");
  if (!existsSync(path.join(output, "worker.js")) || !existsSync(nextEnv)) {
    return ["Artefato não encontrado (.open-next). Rode `npm run cf:build` antes de publicar."];
  }

  let embedded;
  try {
    embedded = nextEnvVariables(nextEnv).filter((key) => !ALLOWED_VARIABLES.has(key));
  } catch {
    problems.push("next-env.mjs: formato inesperado; não foi possível conferir as variáveis.");
    embedded = [];
  }
  if (embedded.length > 0) problems.push(`next-env.mjs embute variáveis: ${embedded.join(", ")}`);

  const literals = privateLiterals(root);
  for (const file of walk(output)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (/(^|\/)\.env(\.|$)/.test(relative) && !relative.endsWith(".env.example")) {
      problems.push(`${relative}: arquivo .env dentro do artefato`);
      continue;
    }
    if (statSync(file).size > 64 * 1024 * 1024) {
      problems.push(`${relative}: arquivo grande demais para conferir`);
      continue;
    }
    const content = readFileSync(file).toString("latin1");
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(content)) problems.push(`${relative}: ${label}`);
    for (const { label, value } of literals) if (content.includes(Buffer.from(value).toString("latin1"))) problems.push(`${relative}: ${label}`);
  }
  return problems.length === 0 ? [] : ["O artefato contém dados privados. NÃO publique:", ...problems.map((problem) => `  - ${problem}`)];
}

const command = process.argv[2];
const root = process.cwd();
const problems = command === "preflight" ? preflight(root) : command === "verify" ? verify(root) : ["Uso: node scripts/cf-guard.mjs <preflight|verify>"];
if (problems.length > 0) {
  console.error(`\n[cf-guard] BLOQUEADO\n${problems.join("\n")}\n`);
  process.exit(1);
}
console.log(`[cf-guard] ${command}: nenhum dado privado encontrado.`);
