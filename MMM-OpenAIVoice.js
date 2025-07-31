/* eslint-env browser */
/**
 * MagicMirror-Modul: OpenAI-Voice-Assistant (Chained).
 * Kurz-Docstrings, PEP 8-ähnliche Benennung.
 * @module MMM-OpenAIVoice
 */
Module.register("MMM-OpenAIVoice", {
  // ---------- Standard-Konfiguration ----------
  defaults: {
    openAiKey: "",
    openAiModel: "gpt-4o-mini",
    transcribeModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    voice: "alloy",
    playbackDevice: "default", // aplay -L
  },

  /** Modul-CSS. */
  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  /** Modul-Start. */
  start() {
    this.conversation = [];
    this.updateDom();
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
  },

  /** Receive global notifications (z. B. von MMM-Hotword2). */
  notificationReceived(notification, payload) {
    if (notification === "OPENAIVOICE_AUDIO" && payload?.filePath) {
      this.sendSocketNotification("OPENAIVOICE_AUDIO", payload);
    }
  },

  /** Receive replies from node_helper. */
  socketNotificationReceived(notification, payload) {
    const map = {
      OPENAIVOICE_TRANSCRIPTION: "👤",
      OPENAIVOICE_RESPONSE: "🤖",
      OPENAIVOICE_ERROR: "⚠️",
    };
    if (map[notification]) this.addChat(map[notification], payload);
  },

  /**
   * Zeile anhängen.
   * @param {string} speaker Emoji.
   * @param {string} text    Inhalt.
   */
  addChat(speaker, text) {
    this.conversation.push({ speaker, text });
    if (this.conversation.length > 8) this.conversation.shift();
    this.updateDom();
  },

  /** DOM erzeugen. */
  getDom() {
    const w = document.createElement("div");
    if (!this.conversation.length) {
      w.innerHTML = "Sag „Hey&nbsp;Mirror…“";
      return w;
    }
    for (const { speaker, text } of this.conversation) {
      const line = document.createElement("div");
      line.innerHTML = `<strong>${speaker}</strong>&nbsp;${text}`;
      w.appendChild(line);
    }
    return w;
  },
});
