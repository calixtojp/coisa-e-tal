// Decifra a mídia da versão pública (gerada por scripts/build.py).
// Cada arquivo cifrado = IV (12 bytes) + texto cifrado AES-256-GCM.
// A chave vem da senha via PBKDF2-SHA256 e fica guardada neste navegador para não pedir de novo.

const KEY_STORAGE = "coisa-e-tal:key";

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function deriveKey(password, enc) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(enc.salt), iterations: enc.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["decrypt"],
  );
}

async function decryptBytes(key, data) {
  const bytes = new Uint8Array(data);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}

async function keyMatches(key, enc) {
  try {
    await decryptBytes(key, fromB64(enc.check));
    return true;
  } catch {
    return false;
  }
}

async function savedKey(enc) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORAGE));
    if (saved?.salt !== enc.salt) return null; // site regerado com outra senha/sal
    const key = await crypto.subtle.importKey("raw", fromB64(saved.key), "AES-GCM", true, ["decrypt"]);
    return (await keyMatches(key, enc)) ? key : null;
  } catch {
    return null;
  }
}

async function saveKey(key, enc) {
  try {
    const raw = await crypto.subtle.exportKey("raw", key);
    localStorage.setItem(KEY_STORAGE, JSON.stringify({ salt: enc.salt, key: toB64(raw) }));
  } catch {}
}

// Mostra a tela de senha (se a chave ainda não estiver salva) e devolve a chave.
async function unlock(enc) {
  const known = await savedKey(enc);
  if (known) return known;

  const gate = document.getElementById("gate");
  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-pass");
  const error = document.getElementById("gate-error");
  const button = form.querySelector("button");

  document.body.classList.add("locked");
  gate.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = "";
      const key = await deriveKey(input.value, enc);
      if (await keyMatches(key, enc)) {
        await saveKey(key, enc);
        gate.hidden = true;
        document.body.classList.remove("locked");
        resolve(key);
      } else {
        error.textContent = "Hmm… não parece ser dos de vdd. Tenta de novo.";
        input.select();
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
      }
      button.disabled = false;
    };
  });
}
