const sseClients = new Set();

function addClient(client) {
  sseClients.add(client);
}

function removeClient(client) {
  sseClients.delete(client);
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  });
}

module.exports = {
  addClient,
  removeClient,
  broadcast
};
