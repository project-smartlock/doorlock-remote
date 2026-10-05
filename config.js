// Deployment settings. A value set here is fixed: its field is hidden from the login form.
// Only public values belong here: this file is served to everyone. Never put a password in it.
export default {
  // WebSocket URL of the broker, e.g. 'wss://97d22f3b8f97414890abfd56b42bfcf0.s1.eu.hivemq.cloud:8884/mqtt'.
  brokerUrl: 'wss://97d22f3b8f97414890abfd56b42bfcf0.s1.eu.hivemq.cloud:8884/mqtt',
  // Lock id, e.g. 'door01'. Leave empty when one deployment serves many locks (users then type it).
  deviceId: 'door01',
};
