const tabChat = document.getElementById("tab-chat");
const tabMap = document.getElementById("tab-map");
const paneChat = document.getElementById("pane-chat");
const paneMap = document.getElementById("pane-map");

function showTab(which) {
  const isChat = which === "chat";
  tabChat.classList.toggle("active", isChat);
  tabMap.classList.toggle("active", !isChat);
  paneChat.hidden = !isChat;
  paneMap.hidden = isChat;
  window.dispatchEvent(new Event("resize"));
}
tabChat.addEventListener("click", () => showTab("chat"));
tabMap.addEventListener("click", () => showTab("map"));

const messagesEl = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const history = [];

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send.disabled = true;

  history.push({ role: "user", content: text });
  addMessage("user", text);
  const pending = addMessage("assistant", "...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    pending.textContent = data.reply;
    history.push({ role: "assistant", content: data.reply });
  } catch (err) {
    pending.className = "msg error";
    pending.textContent = err.message;
    history.pop();
  } finally {
    send.disabled = false;
    input.focus();
  }
});
