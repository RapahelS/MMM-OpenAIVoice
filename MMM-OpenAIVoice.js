/* eslint-env browser */
/**
 * MMM-OpenAIVoice - Frontend
 *
 * Optimiert für das Empfangen von Text-Chunks für eine flüssige Anzeige.
 */
Module.register("MMM-OpenAIVoice", {
  defaults: {
    openAiKey: "", // Besser über .env im Helper-Verzeichnis setzen
    model: "gpt-4o-mini", // Empfehlung: gpt-4o-mini ist neuer und oft schneller/günstiger
    ttsModel: "gpt-4o-mini-tts",
    voice: "alloy",
    playbackDevice: "default",
    silenceMs: 15000, // Nach 15s Stille wird der Kontext zurückgesetzt
    debug: false,
  },

  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  start() {
    this.chatHistory = []; // Vollständiger Verlauf für die Anzeige
    this.currentBotResponseElement = null; // Das DOM-Element für die aktuelle Bot-Antwort
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
    this.updateDom(0); // Start mit sanftem Fade-in
  },

  notificationReceived(notification, payload) {
    if (notification === "OPENAIVOICE_AUDIO_WAKEWORD") {
      // Optional: Visuelles Feedback beim Hören des Weckworts
      const container = document.querySelector(".MMM-OpenAIVoice");
      if (container) container.classList.add("recording");
    }
    if (notification === "OPENAIVOICE_AUDIO_FILE") {
      const container = document.querySelector(".MMM-OpenAIVoice");
      if (container) container.classList.remove("recording");
      this.sendSocketNotification("OPENAIVOICE_PROCESS_AUDIO", payload);
    }
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "OPENAIVOICE_USER_TRANSCRIPTION":
        this.addMessage("👤", payload);
        break;
      case "OPENAIVOICE_BOT_START":
        this.currentBotResponseElement = this.addMessage("🤖", "");
        break;
      case "OPENAIVOICE_BOT_CHUNK":
        if (this.currentBotResponseElement) {
          this.currentBotResponseElement.innerHTML += payload;
        }
        break;
      case "OPENAIVOICE_BOT_END":
        this.currentBotResponseElement = null; // Nächste Nachricht wird eine neue sein
        break;
      case "OPENAIVOICE_ERROR":
        this.addMessage("⚠️", payload);
        break;
    }
  },

  addMessage(tag, text) {
    const chatContainer = document.getElementById("openaivoice-chat");
    if (!chatContainer) return;

    // UI-Logik, um nicht unendlich viele Nachrichten anzuzeigen
    while (chatContainer.children.length > 10) {
      chatContainer.removeChild(chatContainer.firstChild);
    }

    const messageElement = document.createElement("div");
    const tagElement = document.createElement("strong");
    tagElement.innerText = tag + " ";
    messageElement.appendChild(tagElement);

    const textElement = document.createElement("span");
    textElement.innerText = text;
    messageElement.appendChild(textElement);

    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight; // Auto-scroll

    // Gibt das Text-Span zurück, damit es bei Bedarf aktualisiert werden kann
    return textElement;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-OpenAIVoice";

    if (!this.config.openAiKey && !process.env.OPENAI_API_KEY) {
      wrapper.innerHTML = "OpenAI API Key fehlt!";
      wrapper.classList.add("normal", "dimmed");
      return wrapper;
    }

    const chatContainer = document.createElement("div");
    chatContainer.id = "openaivoice-chat";
    chatContainer.innerHTML = "Sag „Computer…“"; // Startnachricht

    wrapper.appendChild(chatContainer);
    return wrapper;
  },
});
