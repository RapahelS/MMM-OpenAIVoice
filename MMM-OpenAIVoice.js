/* eslint-env browser */
/** Front-End für OpenAI-Voice-Assistent (Streaming). */
Module.register("MMM-OpenAIVoice", {
  defaults: {
    openAiKey: "",
    model: "gpt-4.1",
    ttsModel: "gpt-4o-mini-tts",
    voice: "alloy",
    playbackDevice: "default",
    silenceMs: 8000, // nach x ms ohne Sprache neues Weckwort nötig
  },

  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  start() {
    this.chat = [];
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
    this.updateDom();
  },

  /** WAV-Pfad von MMM-Hotword2. */
  notificationReceived(n, p) {
    if (n === "OPENAIVOICE_AUDIO") this.sendSocketNotification(n, p);
  },

  /** Nachrichten vom Helper → Chat-Fenster. */
  socketNotificationReceived(n, p) {
    const tag = { USER: "👤", BOT: "🤖", ERR: "⚠️" }[n] || "";
    this.chat.push({ tag, txt: p });
    if (this.chat.length > 10) this.chat.shift();
    this.updateDom();
  },

  getDom() {
    const w = document.createElement("div");
    if (!this.chat.length) {
      w.innerHTML = "Sag „&nbsp;Computer…“";
      return w;
    }
    this.chat.forEach(({ tag, txt }) => {
      w.insertAdjacentHTML(
        "beforeend",
        `<div><strong>${tag}</strong>&nbsp;${txt}</div>`
      );
    });
    return w;
  },
});
