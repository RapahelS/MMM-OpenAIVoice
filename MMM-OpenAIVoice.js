/* eslint-env browser */
/**
 * MMM-OpenAIVoice - Frontend (Final)
 *
 * - Empfängt die Trigger-Benachrichtigung von MMM-Hotword2.
 * - Sendet den Dateipfad zur Verarbeitung an den Node Helper.
 * - Stellt die transkribierte Nutzer-Eingabe dar.
 * - Zeigt die Antwort des Bots flüssig an, indem es Text-Chunks verarbeitet.
 */
Module.register("MMM-OpenAIVoice", {
  defaults: {
    openAiKey: "", // Wird vom Helper benötigt
    model: "gpt-4o-mini",
    ttsModel: "gpt-4o-mini-tts",
    transcribeModel: "gpt-4o-mini-transcribe",
    voice: "alloy",
    playbackDevice: "default",
    silenceMs: 15000,
    debug: false,
  },

  getStyles() {
    return ["MMM-OpenAIVoice.css"];
  },

  start() {
    this.currentBotResponseElement = null;
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
    this.updateDom(0);
  },

  // Empfängt die Benachrichtigung von MMM-Hotword2
  notificationReceived(notification, payload) {
    if (notification === "OPENAIVOICE_AUDIO") {
      const container = document.querySelector(".MMM-OpenAIVoice");
      if (container) container.classList.remove("recording");

      // Sendet die Benachrichtigung mit dem korrekten Namen an den Node Helper
      this.sendSocketNotification("OPENAIVOICE_PROCESS_AUDIO", payload);
    }

    if (notification === "OPENAIVOICE_ERROR") {
      this.socketNotificationReceived("OPENAIVOICE_ERROR", payload);
    }
  },

  // Empfängt Nachrichten vom Node Helper
  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "OPENAIVOICE_USER_TRANSCRIPTION":
        // Bereinigt die UI für eine neue Konversation
        const chatContainer = document.getElementById("openaivoice-chat");
        if (chatContainer) chatContainer.innerHTML = "";
        this.addMessage("👤", payload);
        break;
      case "OPENAIVOICE_BOT_START":
        this.currentBotResponseElement = this.addMessage("🤖", "");
        break;
      case "OPENAIVOICE_BOT_CHUNK":
        if (this.currentBotResponseElement) {
          // Ersetzt Zeilenumbrüche durch HTML-Tags für die korrekte Anzeige
          this.currentBotResponseElement.innerHTML += payload.replace(
            /\n/g,
            "<br>"
          );
        }
        break;
      case "OPENAIVOICE_BOT_END":
        this.currentBotResponseElement = null; // Antwort ist fertig
        break;
      case "OPENAIVOICE_ERROR":
        this.addMessage("⚠️", payload);
        break;
    }
  },

  // Fügt eine neue Nachricht zum Chat-Fenster hinzu
  addMessage(tag, text) {
    const chatContainer = document.getElementById("openaivoice-chat");
    if (!chatContainer) return null;

    // UI-Logik, um nicht unendlich viele Nachrichten anzuzeigen
    while (chatContainer.children.length > 10) {
      chatContainer.removeChild(chatContainer.firstChild);
    }

    const messageElement = document.createElement("div");
    const tagElement = document.createElement("strong");
    tagElement.innerText = tag + " ";
    messageElement.appendChild(tagElement);

    const textElement = document.createElement("span");
    textElement.innerHTML = text; // innerHTML, um <br> zu rendern
    messageElement.appendChild(textElement);

    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight; // Auto-scroll

    // Gibt das Text-Span zurück, damit es bei Bedarf aktualisiert werden kann
    return textElement;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-OpenAIVoice";

    // Prüft, ob der API-Schlüssel in der Konfiguration vorhanden ist.
    if (!this.config.openAiKey) {
      wrapper.innerHTML = "OpenAI API Key fehlt in der config.js!";
      wrapper.classList.add("normal", "dimmed", "error");
      return wrapper;
    }

    const chatContainer = document.createElement("div");
    chatContainer.id = "openaivoice-chat";
    // Startnachricht wird nur initial gesetzt
    if (wrapper.getElementsByClassName("openaivoice-chat").length === 0) {
      chatContainer.innerHTML = "Sag „Computer…“";
    }

    wrapper.appendChild(chatContainer);
    return wrapper;
  },
});
