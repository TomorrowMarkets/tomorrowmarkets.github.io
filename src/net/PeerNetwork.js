// src/net/PeerNetwork.js
export class PeerNetwork {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.peer = null;
    this.connections = [];
    this.hostConn = null;
    this.isHost = false;
  }

  initHost(roomCode) {
    this.isHost = true;
    this.peer = new Peer('tm-room-' + roomCode);

    this.peer.on('connection', (conn) => {
      this.connections.push(conn);
      conn.on('data', (data) => {
        if (this.eventBus) this.eventBus.emit('NET_DATA_RECEIVED', { conn, data });
      });
    });
  }

  initClient(roomCode, myId) {
    this.isHost = false;
    this.peer = new Peer('tm-client-' + myId);

    this.peer.on('open', () => {
      this.hostConn = this.peer.connect('tm-room-' + roomCode);
      this.hostConn.on('data', (data) => {
        if (this.eventBus) this.eventBus.emit('NET_DATA_RECEIVED', { data });
      });
    });
  }

  broadcast(data) {
    if (this.isHost) {
      this.connections.forEach(conn => { if (conn.open) conn.send(data); });
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(data);
    }
  }
}
