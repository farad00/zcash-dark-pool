import { openLocalVault } from "./local-vault.mjs";
import { BACKUP_MAX_BYTES } from "./ticket-backup.mjs";

export const EXPORT_WARNING =
  "Export an unencrypted bearer credential? Anyone obtaining a usable copy may later exercise this ticket's eligible claim/refund authority. Importing another copy does not revoke previously copied files. Keep it private and avoid shared or synced storage.";

export async function mountBackup(document, confirmExport) {
  const list = document.getElementById("backup-records"),
    message = document.getElementById("backup-message"),
    fileInput = document.getElementById("backup-file"),
    restore = document.getElementById("restore");
  let vault,
    busy = false;
  const failure = (error) => {
    message.textContent =
      error?.message === "TICKET_BACKUP_CONFLICT"
        ? "Backup conflicts with an existing credential. Existing records have been kept."
        : error?.message === "INVALID_TICKET_BACKUP"
          ? "Backup is invalid, unsupported or too large. Existing records have been kept."
          : "Local backup or storage operation failed safely. Existing data has not been reset.";
  };
  async function render() {
    const records = await vault.list();
    const items = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i],
        eligible = await vault.canExport(record.local_id);
      const item = document.createElement("li"),
        text = document.createElement("p"),
        button = document.createElement("button");
      text.textContent = `Local ticket ${i + 1}: ${eligible ? "credential available for backup; server status not checked" : "not exportable; complete and save the same issuance attempt first"}.`;
      button.type = "button";
      button.textContent = "Export individual backup…";
      button.disabled = !eligible;
      button.addEventListener("click", () =>
        work(async () => {
          if ((await confirmExport(EXPORT_WARNING)) !== true) {
            message.textContent = "Export cancelled. No file was created.";
            return;
          }
          const text = await vault.exportBackup(record.local_id);
          const blob = new globalThis.Blob([text], {
            type: "application/json;charset=utf-8",
          });
          const url = URL.createObjectURL(blob),
            link = document.createElement("a");
          try {
            link.href = url;
            link.download = "darkpool-ticket-backup.json";
            link.hidden = true;
            document.body.append(link);
            link.click();
            message.textContent =
              "Backup download requested. Verify you retained the file securely; a download request does not prove it was saved.";
          } finally {
            link.remove();
            // The opaque temporary Blob URL contains no credential. Release it
            // after the browser has had time to start the user-requested download.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        }),
      );
      item.append(text, button);
      items.push(item);
    }
    list.replaceChildren(...items);
  }
  async function work(action) {
    if (busy) return;
    busy = true;
    for (const button of document.querySelectorAll("button"))
      button.disabled = true;
    fileInput.disabled = true;
    try {
      await action();
    } catch (error) {
      failure(error);
    } finally {
      try {
        await render();
      } catch (error) {
        failure(error);
      }
      busy = false;
      fileInput.disabled = false;
      restore.disabled = false;
    }
  }
  try {
    vault = await openLocalVault();
    await render();
    restore.disabled = false;
    restore.addEventListener("click", () =>
      work(async () => {
        let bytes;
        try {
          const file = fileInput.files?.[0];
          if (!file || file.size > BACKUP_MAX_BYTES)
            throw new Error("INVALID_TICKET_BACKUP");
          bytes = new Uint8Array(await file.arrayBuffer());
          const result = await vault.importBackup(bytes);
          message.textContent =
            result === "ALREADY_STORED"
              ? "Already stored. Server status has not been checked."
              : "Credential restored. Server status has not been checked.";
        } finally {
          bytes?.fill(0);
          fileInput.value = "";
        }
      }),
    );
    message.textContent =
      "Local backup ready. No server status has been checked.";
    return vault;
  } catch (error) {
    vault?.close();
    failure(error);
  }
}

if (globalThis.document)
  void mountBackup(globalThis.document, (message) =>
    globalThis.confirm(message),
  );
