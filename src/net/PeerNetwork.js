
import { events } from '../EventBus.js';

export class PeerNetwork {
  constructor() {
    this.peer = null;
    this.connections = [];

    // Broadcast local trades to connected peers
    events.on('TRADE_EXECUTED', (trade) => this.broadcast({ type: 'TRADE', trade }));
  }

  broadcast(message) {
    this.connections.forEach(conn => conn.send(message));
  }

  onReceiveMessage(data) {
    if (data.type === 'SUBMIT_ORDER') {
      // Forward incoming peer order to local EventBus
      events.emit('REMOTE_ORDER_RECEIVED', data.order);
    }
  }
}
