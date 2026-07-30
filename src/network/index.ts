import { Node } from './node';
import Topology from './topology';
import { retry, abortable, readJSON, Cancelable } from '../utils';
import NodeConnection from './node_connection';
import TransactionPack from '../models/transaction_pack';
import Parcel from '../models/parcel';
import HashId from '../models/hash_id';
import { Estimator } from './estimator';

const mainnet = require('../../mainnet.json');

import {
  decode64,
  encode64,
  PrivateKey
} from 'unicrypto';
import BossSingleton from '../boss';
const boss = BossSingleton.getInstance();

const CHECK_CONTRACT_TIMEOUT = 2000;

function createHashId(id: Uint8Array) {
  return {
    __type: "HashId",
    composite3: id
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface NetworkOptions {
  topologyKey?: string,
  topology?: Topology,
  topologyFile?: string,
  directConnection?: boolean
}

interface ContractState {
  isApproved: boolean,
  isTestnet: boolean,
  states: any
}

export interface NetworkApproval {
  id: Uint8Array;
  meanTime: Date;
  stdevSeconds: number;
  trustLevel: number;
}

interface ParcelState {
  payment: ItemResult,
  payload: ItemResult
}

interface ItemResult {
  createdAt: Date | null,
  extra: any,
  __type: string,
  isTestnet: boolean,
  state: string,
  haveCopy: boolean,
  lockedById: any,
  expiresAt: Date | null,
  errors: any
}

interface ItemResultResponse {
  itemResult: ItemResult
}

type ConnectionDict = { [id: string]: NodeConnection };

export default class Network {
  options: NetworkOptions;
  connections: ConnectionDict;
  topologyKey: string;
  directConnection: boolean;
  ready: Promise<void>;
  authKey: PrivateKey;
  setReady: any;
  rejectReady: any;
  topology: Topology | undefined;
  timeOffset: number | null;
  timeUpdatedAt: number | null;
  private readyState: 'pending' | 'fulfilled' | 'rejected';
  private connecting: Promise<this> | null;

  constructor(privateKey: PrivateKey, options?: NetworkOptions) {
    this.options = options || {};
    this.connections = {};
    this.topologyKey = this.options.topologyKey || "__universa_topology";
    this.directConnection = this.options.directConnection || false;
    this.readyState = 'pending';
    this.connecting = null;
    this.resetReady();
    this.authKey = privateKey;
    this.timeOffset = null;
    this.timeUpdatedAt = null;
  }

  private resetReady() {
    this.readyState = 'pending';
    this.ready = new Promise<void>((resolve, reject) => {
      this.setReady = resolve;
      this.rejectReady = reject;
    });

    // `connect()` also returns the failure, so `ready` may have no direct
    // consumer. Mark it handled without changing what its consumers observe.
    this.ready.catch(() => undefined);
  }

  size() {
    if (this.topology) return this.topology.size();

    throw new Error("You need to connect before accessing size");
  }

  async getLastTopology() {
    if (typeof window !== 'undefined') {
      const bin = localStorage.getItem(this.topologyKey);

      if (bin) {
        return Topology.load(boss.load(decode64(bin)));
      }
    }

    if (this.options.topology) return this.options.topology;

    if (this.options.topologyFile) {
      const packed = await readJSON(this.options.topologyFile);
      return Topology.load(packed);
    }

    return Topology.load(mainnet);
  }

  saveNewTopology() {
    if (typeof window === 'undefined') return;

    if (!this.topology) throw new Error("Can't save undefined topology");
    const packed = this.topology.pack();
    localStorage.setItem(this.topologyKey, encode64(boss.dump(packed)));
  }

  connect(): Promise<this> {
    if (this.connecting) return this.connecting;
    if (this.readyState !== 'pending') this.resetReady();

    this.connecting = this.performConnect();
    return this.connecting;
  }

  private async performConnect(): Promise<this> {
    try {
      this.topology = await this.getLastTopology();
      // console.log(`Connecting to the Universa network`);
      await this.topology.update(this.directConnection);
      // console.log(`Loaded network configuration, ${this.size()} nodes`);
      this.saveNewTopology();

      if (this.timeOffset === null) {
        try {
          await this.loadNetworkTime();
        } catch (err) {
          // Network time is an optional service and must not prevent access
          // to an otherwise functioning Universa network.
        }
      }

      this.readyState = 'fulfilled';
      this.setReady();

      return this;
    } catch (err) {
      this.readyState = 'rejected';
      this.rejectReady(err);
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  async nodeConnection(nodeId: string) {
    if (!this.topology)
      throw new Error("can't establish connection without topology");

    const node = this.topology.getNode(nodeId);
    if (this.connections[nodeId]) return this.connections[nodeId];

    await this.ready;

    const connection = new NodeConnection(node, this.authKey, this.directConnection);
    await connection.connect();
    this.connections[nodeId] = connection;

    return connection;
  }

  async getRandomConnection() {
    await this.ready;

    if (!this.topology)
      throw new Error("can't establish connection without topology");

    return this.nodeConnection(this.topology.getRandomNodeId());
  }

  command(
    name: string,
    options?: any,
    connection?: NodeConnection,
    requestOptions?: any
  ) {
    let req: any, conn: NodeConnection;

    const run = async () => {
      conn = connection || await this.getRandomConnection();

      try {
        req = conn.command(name, options, requestOptions);
        return await req;
      } catch (error) {
        if (!connection) {
          const nodeId = await conn.node.getId();
          if (nodeId) delete this.connections[nodeId];
        }
        throw error;
      }
    };

    return abortable(retry(run, {
      attempts: 5,
      interval: 1000,
      onError: (e: Error) => console.log(e, ` send command again`)
    }), () => req);
  }

  getState(
    id: HashId | Uint8Array | string,
    connection?: NodeConnection,
    requestOptions?: any) {
    let itemId: Uint8Array;
    if (typeof id === "string") itemId = decode64(id);
    else if (id.constructor.name === 'HashId') itemId = (id as HashId).composite3;
    else itemId = id as Uint8Array;

    const hashId = createHashId(itemId);

    return this.command("getState", { itemId: hashId }, connection, requestOptions || {});
  }

  checkParcel(id: Uint8Array | string) {
    let itemId: Uint8Array;
    if (typeof id === "string") itemId = decode64(id);
    else itemId = id;

    const hashId = createHashId(itemId);

    return this.command("getParcelProcessingState", { parcelId: hashId });
  }

  checkContract(
    id: HashId | Uint8Array | string,
    trustLevel: number
  ): Promise<NetworkApproval|null> {
    const self = this;
    let itemId: Uint8Array;
    if (typeof id === "string") itemId = decode64(id);
    else if (id.constructor.name === 'HashId') itemId = (id as HashId).composite3;
    else itemId = id as Uint8Array;

    return new Promise((resolve, reject) => {
      let tLevel = trustLevel;
      if (tLevel > 0.9) tLevel = 0.9;

      const size = self.size();
      if (!size) throw new Error("missing topology");

      let Nt = Math.ceil(size * tLevel);
      if (Nt < 1) Nt = 1;
      const N10 = (Math.floor(size * 0.1)) + 1;
      const Nn = Math.max(Nt + 1, N10);

      let resultFound = false;

      let createdAtList: Array<Date> = [];
      let positive = 0;
      let negative = 0;
      let states: { [st: string]: number } = {};
      let isTestnet: boolean;

      const requests: Array<Cancelable<any>> = [];
      if (!self.topology) throw new Error("missing topology");
      const ids = Object.keys(self.topology.nodes);

      const isPending = (state: string) =>
        state.indexOf("PENDING") === 0 || state.indexOf("LOCKED") === 0;

      function success(status: boolean) {
        if (resultFound) return;

        resultFound = true;

        if (!status) return resolve(null);

        const createdAtMs = createdAtList.map(d => d.getTime());
        const meanT = createdAtMs.reduce((p, n) => p + n) / createdAtMs.length;
        const meanTime = new Date(meanT);

        const estimator = new Estimator();
        createdAtMs.forEach(c => estimator.addSample(c / 1000));

        const result: NetworkApproval = {
          id: itemId,
          meanTime,
          stdevSeconds: estimator.stdev,
          trustLevel: Nn / size
        };

        resolve(result);
      }

      function failure(err: Error) {
        if (resultFound) return;

        resultFound = true;
        reject(err);
      }

      function processNext() {
        if (!resultFound && ids.length > 0) {
          const id = ids.pop();
          id && processNode(id);
        } else failure(new Error("not enough responses to find consensus"));
      }

      function processVote(itemResult: ItemResult, nodeId: string) {
        if (resultFound) return;
        const { state } = itemResult;
        if (isPending(state)) return ids.unshift(nodeId);

        if (!states[state]) states[state] = 1;
        else states[state] += 1;

        if (state === "APPROVED") {
          positive++;
          if (itemResult.createdAt) createdAtList.push(itemResult.createdAt);
          if (positive >= Nt) return success(true);
        }
        else {
          negative++;
          if (negative >= N10) return success(false);
        }

        if (positive + negative >= Nt) processNext();
      }

      async function processNode(nodeId: string) {
        if (resultFound) return;

        try {
          const conn = await self.nodeConnection(nodeId);
          if (resultFound) return;

          const req = self.getState(id, conn, {
            timeout: CHECK_CONTRACT_TIMEOUT
          });
          requests.push(req);
          const response = await req;
          const { itemResult } = response;

          isTestnet = itemResult.isTestnet;

          processVote(itemResult, nodeId);
        } catch (err) {
          console.log("On check contract: ", err);
          if (ids.length > 0) processNext();
          else failure(new Error("not enough responses"));
        }
      }

      for (let i = 0; i < Nt; i++) processNext();
    });
  }

  isApprovedExtended(
    id: Uint8Array | string,
    trustLevel: number,
    onNodeResponse?: (response: any) => void
  ): Promise<ContractState> {
    const self = this;

    return new Promise((resolve, reject) => {
      let tLevel = trustLevel;
      if (tLevel > 0.9) tLevel = 0.9;

      // const end = new Date((new Date()).getTime() + millisToWait).getTime();
      const size = self.size();
      if (!size) throw new Error("missing topology");

      let Nt = Math.ceil(size * tLevel);
      if (Nt < 1) Nt = 1;
      const N10 = (Math.floor(size * 0.1)) + 1;
      const Nn = Math.max(Nt + 1, N10);
      let resultFound = false;

      let positive = 0;
      let negative = 0;
      let states: { [st: string]: number } = {};
      let isTestnet: boolean;

      const requests: Array<Cancelable<any>> = [];
      if (!self.topology) throw new Error("missing topology");
      const ids = Object.keys(self.topology.nodes);

      const isPending = (state: string) =>
        state.indexOf("PENDING") === 0 || state.indexOf("LOCKED") === 0;

      function success(status: boolean) {
        if (resultFound) return;

        resultFound = true;

        resolve({
          isApproved: status,
          isTestnet,
          states
        });
      }

      function failure(err: Error) {
        if (resultFound) return;

        resultFound = true;
        reject(err);
      }

      function processNext() {
        if (!resultFound && ids.length > 0) {
          const id = ids.pop();
          id && processNode(id);
        } else failure(new Error("not enough responses to find consensus"));
      }

      function processVote(state: string, nodeId: string) {
        if (resultFound) return;
        if (isPending(state)) return ids.unshift(nodeId);

        if (!states[state]) states[state] = 1;
        else states[state] += 1;

        if (state === "APPROVED") {
          positive++;
          if (positive >= Nt) return success(true);
        }
        else {
          negative++;
          if (negative >= N10) return success(false);
        }

        if (positive + negative >= Nt) processNext();
      }

      async function processNode(nodeId: string) {
        if (resultFound) return;

        try {
          const conn = await self.nodeConnection(nodeId);
          if (resultFound) return;

          const req = self.getState(id, conn, {
            timeout: CHECK_CONTRACT_TIMEOUT
          });
          requests.push(req);
          const response = await req;
          const { itemResult } = response;
          // console.log(itemResult);

          if (onNodeResponse) onNodeResponse({ nodeId, itemResult });

          isTestnet = itemResult.isTestnet;

          processVote(itemResult.state, nodeId);
        } catch (err) {
          console.log("On check contract: ", err);
          if (ids.length > 0) processNext();
          else failure(new Error("not enough responses"));
        }
      }

      for (let i = 0; i < Nt; i++) processNext();
    });
  }

  isApproved(id: Uint8Array | string, trustLevel: number): Promise<boolean> {
    return this.isApprovedExtended(id, trustLevel).then(result => result.isApproved);
  }

  now() {
    if (this.timeOffset === null)
      throw new Error('you should load network time before');

    const localTime = Date.now();

    return new Date(localTime + this.timeOffset);
  }

  async loadNetworkTime() {
    const url = 'https://xchange.mainnetwork.io/api/v1/utc';
    const response = await NodeConnection.xchangeRequest('GET', url, { timeout: 3000 });
    const uTime = response.currentEpochSecond * 1000;
    const localTime = Date.now();

    this.timeOffset = uTime - localTime;
    this.timeUpdatedAt = localTime;
  }

  static async getCost(tpack: TransactionPack) {
    const url = 'https://xchange.mainnetwork.io/api/v1/contracts/cost';
    const binary = await tpack.pack();
    const data = { packedContract: encode64(binary) };

    return NodeConnection.xchangeRequest('POST', url, { data });
  }

  async registerParcel(parcel: Parcel): Promise<ParcelState> {
    const self = this;

    const packedItem = boss.dump(parcel);
    const connection = await this.getRandomConnection();

    const paymentId = await parcel.payment.contract.hashId();
    const payloadId = await parcel.payload.contract.hashId();

    if (!paymentId || !payloadId) throw new Error('payment or payload wasn\'t saved!');

    let response, error;

    try {
      response = await this.command('approveParcel',
        { packedItem },
        connection,
        { timeout: 3000 }
      );
    } catch (err) {
      error = err;

      return this.registerParcel(parcel);
    }

    const paymentState = await finalState(paymentId);
    const payloadState = await finalState(payloadId);

    return {
      payment: paymentState,
      payload: payloadState
    };

    async function finalState(id: HashId): Promise<ItemResult> {
      async function check(response: ItemResultResponse) {
        const { itemResult } = response;
        const { state } = itemResult;

        // console.log(state);

        if (!state.startsWith("PENDING")) return itemResult;

        await sleep(100);

        return await finalState(id);
      }

      const response = await self.getState(id, connection);

      return await check(response);
    }
  }
}
