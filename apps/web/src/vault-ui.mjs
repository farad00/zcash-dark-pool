import { openLocalVault } from "./local-vault.mjs";

export async function mountVault(document, confirmRemoval) {
  const button = document.getElementById("create-draft");
  const message = document.getElementById("message");
  const list = document.getElementById("records");
  let vault,
    busy = false;
  const error = () => {
    message.textContent =
      "Local storage could not be read or changed safely. Existing data has not been reset. Keep this browser data and any individual backups; the server cannot recover your secret.";
  };
  async function render() {
    const records = await vault.list();
    list.replaceChildren();
    for (const record of records) {
      const item = document.createElement("li");
      const text = document.createElement("p");
      text.textContent =
        record.state === "DRAFT"
          ? "Local draft — no server ticket ID; no prediction submitted."
          : `Finalized local credential — market ${record.market_id}. Funding and claim eligibility are not checked.`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete local record…";
      remove.addEventListener("click", () =>
        work(async () => {
          const deleted = await vault.remove(record.local_id, () =>
            confirmRemoval(
              "Permanently delete this local record and its claim secret? Keep an individual backup of an eligible issued ticket first. Deletion without a usable backup can permanently remove claim/refund capability. The server cannot recover it.",
            ),
          );
          await render();
          message.textContent = deleted
            ? "Local record deleted after confirmation."
            : "Deletion cancelled. Local credential kept.";
        }),
      );
      item.append(text, remove);
      list.append(item);
    }
  }
  async function work(action) {
    if (busy) return;
    busy = true;
    for (const control of document.querySelectorAll("button"))
      control.disabled = true;
    try {
      await action();
    } catch {
      error();
    } finally {
      busy = false;
      for (const control of document.querySelectorAll("button"))
        control.disabled = false;
    }
  }
  try {
    vault = await openLocalVault();
    await render();
    message.textContent =
      "Local vault ready. No ticket or portfolio data is sent to a server.";
    button.disabled = false;
    button.addEventListener("click", () =>
      work(async () => {
        await vault.createDraft();
        await render();
        message.textContent =
          "Draft secret saved locally. No prediction has been submitted.";
      }),
    );
    return vault;
  } catch {
    error();
  }
}

if (globalThis.document)
  void mountVault(globalThis.document, (message) =>
    globalThis.confirm(message),
  );
