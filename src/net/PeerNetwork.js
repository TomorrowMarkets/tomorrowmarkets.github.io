// src/net/PeerNetwork.js
export class PeerNetwork {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.peer = null;
    this.connections = [];
    this.hostConn = null;
    this.isHost = false;
    // Closing the tab closes our connections properly, so the room hears
    // about it straight away instead of waiting for a timeout.
    window.addEventListener('pagehide', () => {
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
    });
  }

  initHost(roomCode) {
    this.isHost = true;
    this.peer = new Peer('tm-room-' + roomCode);

    this.peer.on('connection', (conn) => {
      this.connections.push(conn);

      conn.on('data', (data) => {
        if (this.eventBus) this.eventBus.emit('NET_DATA_RECEIVED', { conn, data });
      });

      // 'close' doesn't always fire when a player's tab simply disappears,
      // so a failed or disconnected WebRTC link counts as leaving too.
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        this.connections = this.connections.filter(c => c !== conn);
        if (this.eventBus) this.eventBus.emit('NET_CLIENT_DISCONNECTED', conn);
      };
      conn.on('close', leave);
      conn.on('error', leave);
      conn.on('iceStateChanged', (state) => {
        if (state === 'failed' || state === 'closed' || state === 'disconnected') leave();
      });

      if (this.eventBus) this.eventBus.emit('NET_CLIENT_CONNECTED', conn);
    });
  }

  initClient(roomCode, myId) {
    this.isHost = false;
    this.peer = new Peer('tm-client-' + myId);

    this.peer.on('open', () => {
      this.hostConn = this.peer.connect('tm-room-' + roomCode);

      this.hostConn.on('open', () => {
        if (this.eventBus) this.eventBus.emit('NET_HOST_CONNECTED');
      });

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
