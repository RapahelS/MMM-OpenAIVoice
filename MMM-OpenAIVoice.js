/* eslint-env browser */
/**
 * MagicMirror-Modul: OpenAI-Voice-Assistant.
 * Ultrakurze Google-Style-Docstrings, PEP 8-ähnliche Namenskonvention für Konsistenz.
 * @module MMM-OpenAIVoice
 */

Module.register("MMM-OpenAIVoice", {
  // ---------- Standard-Konfiguration ----------
  defaults: {
    wakeWord: "assets/Hey-Spiegel_de_raspberry-pi_v3_0_0.ppn",
    porcupineAccessKey: "",
    openAiKey: "",
    openAiModel: "gpt-4o-mini",
    transcribeModel: "gpt-4o-mini-transcribe", // Fallback siehe helper
    ttsModel: "gpt-4o-mini-tts", // Fallback siehe helper
    voice: "alloy",
    maxRecordSeconds: 10,
    recordProgram: "arecord",
    alsaDevice: null,
  },

  /** Liefert Modul-CSS. */
  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  /** Initialisiert das Modul. */
  start() {
    this.conversation = [];
    this.updateDom(); // UI sofort
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
  },

  /** Verarbeitet Nachrichten vom Node-Helper. */
  socketNotificationReceived(notification, payload) {
    const map = {
      OPENAIVOICE_TRANSCRIPTION: "👤",
      OPENAIVOICE_RESPONSE: "🤖",
      OPENAIVOICE_ERROR: "⚠️",
    };
    if (map[notification]) this.addChat(map[notification], payload);
  },

  /**
   * Fügt neue Chatzeile hinzu.
   * @param {string} speaker Emoji/Icon.
   * @param {string} text    Inhalt.
   */
  addChat(speaker, text) {
    this.conversation.push({ speaker, text });
    if (this.conversation.length > 8) this.conversation.shift();
    this.updateDom();
  },

  /** Baut DOM-Baum. */
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
