import { createServer, type Server } from "node:net";
import { Aedes } from "aedes";

// The runtime only talks to the broker through this small interface plus a plain MQTT client (src/mqttClient.ts) on loopback.
// Mosquitto can replace Aedes later by providing another MqttBroker implementation (or by running as its own unit and using NullBroker).
export interface MqttBroker { start(): Promise<void>; stop(): Promise<void>; }

// Embedded Aedes broker. Loopback only, in-memory persistence: nothing is retained across restarts, so an old command can never be replayed.
export class AedesBroker implements MqttBroker {
  private server?: Server; private aedes?: Aedes;
  constructor(private port: number, private host = "127.0.0.1") {}
  async start() {
    this.aedes = await Aedes.createBroker();
    this.server = createServer(this.aedes.handle);
    await new Promise<void>((res, rej) => { this.server!.once("error", rej); this.server!.listen(this.port, this.host, res); });
  }
  async stop() {
    await new Promise<void>((r) => this.server ? this.server.close(() => r()) : r());
    await new Promise<void>((r) => this.aedes ? this.aedes.close(() => r()) : r());
  }
}

// For a box where an external Mosquitto is already running.
export class NullBroker implements MqttBroker { async start() {} async stop() {} }
