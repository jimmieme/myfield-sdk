import { createInstance, createInstanceKey, createAuthorizationStorage } from "@myfield/sdk";

import { encodeNoteVersion, decodeNoteVersion } from "./note-codec.js";

const editor = document.querySelector("#note");
const save = document.querySelector("#save");
const connect = document.querySelector("#connect");
const status = document.querySelector("#status");
const appId = "remote-api.example.com";
const encoder = new TextEncoder();
let database, storage, record, instance, remote, headVersionId = null;
let dirty = false, uncertain = false;
editor.oninput = () => { dirty = true; };
function showError(error) { status.textContent = error.message; }

async function openRemote(grant) {
  const server = instance.remote;
  server.bind(grant);
  const client = server.bucket;
  await readNote(client, grant);
  remote = client;
}

async function readNote(client, grant) {
  const head = await client.getCurrent(record.objectId);
  let data = null;
  if (head) {
    const version = await client.getVersion(record.objectId, head.versionId);
    data = await decodeNoteVersion(version, grant);
  }
  if (!dirty) editor.value = data === null ? "" : new TextDecoder().decode(data);
  headVersionId = head?.versionId ?? null;
  status.textContent = "Loaded from remote";
}

async function saveNote() {
  const version = await encodeNoteVersion({
    objectId: record.objectId, parentVersionIds: headVersionId ? [headVersionId] : [],
    data: encoder.encode(editor.value),
  }, record.grant);
  try {
    const result = await remote.commit({ ...version, expectedHeadVersionId: headVersionId });
    if (!result.ok) throw new Error("Remote note changed. Reload before saving.");
  } catch (error) {
    uncertain = true;
    throw new Error(`${error.message} Save paused; keep a copy of your text and reload to check the remote note.`, { cause: error });
  }
  headVersionId = version.meta.versionId;
  dirty = false;
  status.textContent = "Saved remotely";
}

async function action(run) {
  editor.disabled = save.disabled = connect.disabled = true;
  try { await run(); }
  catch (error) { showError(error); }
  finally { editor.disabled = false; save.disabled = !remote || uncertain; connect.disabled = uncertain; }
}
save.onclick = () => action(saveNote);
connect.onclick = () => action(async () => {
  if (remote) return;
  const grant = record.grant ?? await instance.remote.auth.authorize({ mode: "popup" });
  if (!record.grant) {
    const next = { ...record, grant };
    await storage.set("note", next);
    record = next;
  }
  await openRemote(grant);
});

async function start() {
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("myfield-remote-api-example", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("example");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.onversionchange = () => database.close();
  storage = createAuthorizationStorage({ database, store: "example" });
  record = await storage.get("note");
  if (record === null) {
    await storage.add("note", { v: 3, instanceKey: await createInstanceKey(), objectId: crypto.randomUUID(), grant: null });
    record = await storage.get("note");
  }
  if (record?.v !== 3 || !(record.instanceKey?.signingPrivateKey instanceof CryptoKey)
    || typeof record.objectId !== "string") throw new Error("Stored example data is incompatible; no identity or data was replaced.");
  if (record.grant && (record.grant.instanceId !== record.instanceKey.instanceId
    || !(record.grant.payloadKey instanceof CryptoKey) || record.grant.payloadKey.extractable)) throw new Error("Stored authorization is invalid.");
  const authBase = new URLSearchParams(location.search).get("authBase") || undefined;
  instance = createInstance(appId, { instanceKey: record.instanceKey, authBase, authStorage: { database, store: "example" } });
  const grant = await instance.remote.auth.handleCallback();
  if (grant) {
    record = { ...record, grant };
    await storage.set("note", record);
  }
  if (record.grant) await openRemote(record.grant);
  else status.textContent = "Connect to authorize this browser";
}
try { await start(); }
catch (error) { showError(error); }
finally { connect.disabled = !instance; save.disabled = !remote; }
window.addEventListener("pagehide", event => { if (!event.persisted) { instance?.dispose(); database?.close(); } });
