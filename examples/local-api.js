import { createInstance } from "@myfield/sdk";

const editor = document.querySelector("#note");
const save = document.querySelector("#save");
const connect = document.querySelector("#connect");
const status = document.querySelector("#status");
const authBase = new URLSearchParams(location.search).get("authBase") || undefined;
// Omitted authBase uses https://myfield.one/auth/.
const instance = createInstance("local-api.example.com", { authBase });
const bucket = instance.bucket;
let dirty = false;
editor.oninput = () => { dirty = true; };

function showError(error) {
  status.textContent = error.message;
}
async function readNote() {
  const note = await bucket.get("note:1");
  if (!dirty) editor.value = note?.text ?? "";
}
bucket.on("change", id => {
  if (id === "note:1") void readNote().catch(showError);
});
instance.on("state", (state, detail) => {
  status.textContent = detail || state;
});

async function action(run) {
  editor.disabled = save.disabled = connect.disabled = true;
  try { await run(); }
  catch (error) { showError(error); }
  finally { editor.disabled = save.disabled = connect.disabled = false; }
}
save.onclick = () => action(async () => {
  await bucket.put("note:1", { text: editor.value });
  dirty = false;
  status.textContent = "Saved locally";
});
connect.onclick = () => action(() => instance.connect());

try {
  await readNote();
  save.disabled = false;
  status.textContent = "Ready locally";
  void instance.resume().catch(showError).finally(() => { connect.disabled = false; });
} catch (error) { showError(error); }
window.addEventListener("pagehide", event => {
  if (!event.persisted) instance.dispose();
});
