/* global Module, Log */
Module.register("MMM-OpenAIVoice", {
  // ---------- Standard-Konfiguration ----------
  defaults: {
    wakeWord: "assets/Hey-Spiegel_de_raspberry-pi_v3_0_0.ppn",
    porcupineAccessKey: "",
    openAiKey: "", // leer: fällt auf process.env zurück
    openAiModel: "gpt-4o-mini",
    transcribeModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    voice: "alloy",
    maxRecordSeconds: 10,
    recordProgram: "arecord",
    alsaDevice: null, // z. B. "plughw:1,0"
  },

  /**
   * CSS laden.
   * @returns {string[]} – Pfade zu CSS-Dateien
   */
  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  /**
   * Modul initialisieren.
   */
  start() {
    this.conversation = [];
    // UI sofort initialisieren
    this.updateDom();
    // Node-Helper starten
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
  },

  /**
   * Socket-Nachrichten vom Node-Helper verarbeiten.
   */
  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "OPENAIVOICE_TRANSCRIPTION":
        this.addChat("👤", payload);
        break;
      case "OPENAIVOICE_RESPONSE":
        this.addChat("🤖", payload);
        break;
      case "OPENAIVOICE_ERROR":
        this.addChat("⚠️", payload);
        break;
      default:
      // ignore
    }
  },

  /**
   * Fügt eine Zeile zur Konversationsansicht hinzu.
   * @param {string} speaker – Icon
   * @param {string} text    – Inhalt
   */
  addChat(speaker, text) {
    this.conversation.push({ speaker, text });
    if (this.conversation.length > 8) this.conversation.shift();
    this.updateDom();
  },

  /**
   * DOM erzeugen.
   * @returns {HTMLElement}
   */
  getDom() {
    const wrapper = document.createElement("div");
    if (this.conversation.length === 0) {
      wrapper.innerHTML = "Sag „Hey&nbsp;Mirror…“";
      return wrapper;
    }
    this.conversation.forEach(({ speaker, text }) => {
      const line = document.createElement("div");
      line.innerHTML = `<strong>${speaker}</strong>&nbsp;${text}`;
      wrapper.appendChild(line);
    });
    return wrapper;
  },
});
