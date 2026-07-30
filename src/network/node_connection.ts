import { abortable } from '../utils';
import { Node } from './node';
import { PrivateKey, PublicKey, PrivateKeySignOpts, textToBytes } from 'unicrypto';

import {
  randomBytes,
  encode64,
  SHA,
  SymmetricKey
} from 'unicrypto';
import BossSingleton from '../boss';
const boss = BossSingleton.getInstance();

interface FetchOpts {
  method: string,
  headers: any,
  body?: string,
  signal: AbortSignal
}

const CONNECTION_TIMEOUT = 5000;
const CLIENT_VERSION = 3;

export default class NodeConnection {
  node: Node;
  authKey: PrivateKey;
  nodeURL: string;
  sessionId: number | undefined;
  sessionKey: SymmetricKey | undefined;
  version: number | undefined;
  nodePublicKey: PublicKey | undefined;

  constructor(node: Node, authKey: PrivateKey, directConnection?: boolean) {
    this.node = node;
    this.authKey = authKey;

    this.nodeURL = node.https;
    if (directConnection) this.nodeURL = node.http;
  }

  async connect() {
    const clientNonce = randomBytes(47);
    const signatureOpts: PrivateKeySignOpts = { pssHash: "sha512" };

    console.log(`setting up protected connection to ${this.nodeURL}`);

    const clientKey = await this.authKey.publicKey.pack();
    const connectionData = await this.request("connect", {
      client_key: clientKey,
      client_version: CLIENT_VERSION
    }, { timeout: CONNECTION_TIMEOUT });

    this.sessionId = connectionData['session_id'];
    const serverVersion = connectionData['server_version'] || 1;

    this.version = Math.min(serverVersion, CLIENT_VERSION);

    const authData = boss.dump({
      client_nonce: clientNonce,
      server_nonce: connectionData['server_nonce'],
      client_version: CLIENT_VERSION,
      server_version: serverVersion
    });

    const token = await this.request("get_token", {
      data: authData,
      signature: await this.authKey.sign(authData, signatureOpts),
      session_id: this.sessionId
    });

    const tokenData = token.data;
    const nodeKey = await this.node.getPublicKey();

    if (!nodeKey) throw new Error("Node key is undefined");

    const isVerified = await nodeKey.verify(
      tokenData, token.signature, signatureOpts
    );

    if (!isVerified) throw new Error("bad node signature");

    const params = boss.load(tokenData);

    if (encode64(clientNonce) !== encode64(params['client_nonce']))
      throw new Error("nonce mismatch, authentication failed");

    const decryptedTokenBin = await this.authKey.decrypt(params['encrypted_token']);
    const decryptedToken = boss.load(decryptedTokenBin);

    this.sessionKey = new SymmetricKey({ keyBytes: decryptedToken.sk });

    const response = await this.command("hello");

    if (response.status !== "OK")
      throw new Error(`wrong status ${response.status}, authentication failed`);

    console.log(`connected, system says: ${response.message}`);

    return this;
  }

  async command(name: string, params: any = {}, requestOptions: any = {}) {
    if (!this.sessionKey || !this.version) throw new Error("not in session");

    const version = this.version;
    const sk = this.sessionKey;
    const data = boss.dump({ command: name, params });
    let encryptedParams: Uint8Array;

    if (version >= 2) encryptedParams = await sk.etaEncrypt(data);
    else encryptedParams = await sk.encrypt(data);

    const req = this.request("command", {
      command: "command",
      params: encryptedParams,
      session_id: this.sessionId
    }, requestOptions);

    return abortable(new Promise((resolve, reject) => {
      req.then(async (response: any) => {
        let decrypted: Uint8Array;

        if (version >= 2) decrypted = await sk.etaDecrypt(response.result);
        else decrypted = await sk.decrypt(response.result);

        const result = boss.load(decrypted);
        if (result.error) reject(result.error);
        else resolve(result.result);
      }).catch(reject);
    }), req);
  }

  request(path: string, params: any = {}, requestOptions: any = {}) {
    const url = `${this.nodeURL}/${path}`;
    const data = { requestData64: encode64(boss.dump(params)) };

    return NodeConnection.request("POST", url, { data, ...requestOptions });
  }

  static request(method: string, url: string, options: any = {}) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const promise = new Promise((resolve, reject) => {
      let headers = options.headers || {};
      if (method === 'POST') headers = Object.assign({}, headers, {
        'Content-Type': 'application/json'
      });

      let opts: FetchOpts = {
        method,
        headers,
        signal: controller.signal
      };

      if (method === 'POST') opts.body = JSON.stringify(options.data);

      const fetch = (globalThis as any).fetch;
      if (typeof fetch !== 'function') {
        reject(new Error('Fetch API is not available in this environment'));
        return;
      }

      fetch(url, opts).then((res: any) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
          }
          return res.blob();
        })
        .then(function (blob: Blob) {
          return blob.arrayBuffer();
        }).then(function (ab: ArrayBuffer) {
          const response = new Uint8Array(ab);
          const answer = boss.load(response);

          if (answer && answer.result === "ok") resolve(answer.response);
          else reject(answer);

        }).catch((err: Error) => reject(err))
        .finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });

      if (options.timeout) {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Connection timed out"));
        }, options.timeout);
      }
    });

    return abortable(promise, controller);
  }

  static xchangeRequest(method: string, url: string, options: any = {}) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const promise = new Promise((resolve, reject) => {
      let headers = options.headers || {};
      if (method === 'POST') headers = Object.assign({}, headers, {
        'Content-Type': 'application/json'
      });

      let opts: FetchOpts = {
        method,
        headers,
        signal: controller.signal
      };

      if (method === 'POST') opts.body = JSON.stringify(options.data);

      const fetch = (globalThis as any).fetch;
      if (typeof fetch !== 'function') {
        reject(new Error('Fetch API is not available in this environment'));
        return;
      }

      fetch(url, opts).then((res: any) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
        }
        return res.json();
      })
      .then(resolve).catch((err: Error) => reject(err))
      .finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });

      if (options.timeout) {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Connection timed out"));
        }, options.timeout);
      }
    });

    return abortable(promise, controller);
  }
}
