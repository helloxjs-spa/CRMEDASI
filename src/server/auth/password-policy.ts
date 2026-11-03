/**
 * Política de senha: além do tamanho (validation.ts), recusa as senhas que
 * ataques de dicionário tentam primeiro. Não exige combinação de símbolos: o que
 * pesa é o tamanho e não partir de uma palavra óbvia.
 */
const MIN_DISTINCT_CHARS = 5;

/** Base óbvia + só números/símbolos no fim ("Senha@2026", "edasi1234567"). */
const COMMON_ROOTS =
  /^(senha|password|passw0rd|admin|administrador|administrator|edasi|grupoedasi|crm|crmedasi|mudar|mudarsenha|trocar|trocarsenha|teste|test|usuario|user|vendedor|supervisor|qwerty|qwertyuiop|asdfgh|asdfghjkl|zxcvbn|abc|abcd|abcdef|brasil|iloveyou|letmein|welcome|bemvindo)[^a-z]*$/;

/** Frases muito comuns que passam dos 12 caracteres. */
const COMMON_PASSWORDS = new Set(["senhasenha", "senhasenhasenha", "passwordpassword", "adminadmin", "adminadminadmin", "minhasenha", "minhanovasenha", "senhaforte", "senhasegura"]);

const SEQUENCES = ["0123456789012345678901234567890", "9876543210987654321098765432109", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"];

export function isCommonPassword(password: string): boolean {
  const normalized = password.toLowerCase();
  if (new Set(normalized).size < MIN_DISTINCT_CHARS) return true;
  if (COMMON_ROOTS.test(normalized)) return true;

  const lettersAndDigits = normalized.replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(lettersAndDigits)) return true;
  if (lettersAndDigits.length > 0 && SEQUENCES.some((sequence) => sequence.includes(lettersAndDigits))) return true;
  return /^(.{1,4})\1+$/.test(normalized); // repetição de um trecho curto: "abcdabcdabcd"
}
