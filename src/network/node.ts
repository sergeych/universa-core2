import NodeConnection from './node_connection';

import {
  PublicKey,
  decode64,
  encode64
} from 'unicrypto';
import BossSingleton from '../boss';
const boss = BossSingleton.getInstance();

function rewriteProtocol(value: string, protocol: "http:" | "https:") {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`unsupported node URL protocol: ${url.protocol}`);

  const oldPort = url.port;
  url.protocol = protocol;

  // Universa's traditional topology uses port 8080 for HTTP and 443 for
  // HTTPS. Only translate those exact ports; string replacement used to also
  // corrupt ports such as 80800 and URL paths containing ":8080".
  if (protocol === "https:" && oldPort === "8080") url.port = "443";
  if (protocol === "http:" && oldPort === "443") url.port = "8080";

  return url.toString().replace(/\/$/, "");
}

function validateNodeURL(value: string, nodeName: string, field: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`unsupported protocol ${url.protocol}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid node ${nodeName}: invalid ${field} URL ${value} (${reason})`);
  }
}

const forceHTTPS = (url: string) => rewriteProtocol(url, "https:");

const forceHTTP = (url: string) => rewriteProtocol(url, "http:");

const GET_TOPOLOGY_TIMEOUT = 1000;

function difference(setA: Set<string>, setB: Set<string>) {
  let _difference = new Set(setA);

  setB.forEach((elem) => _difference.delete(elem));

  return _difference;
}

function isEqual(setA: Set<string>, setB: Set<string>) {
  if (setA.size !== setB.size) return false;

  const diff = difference(setA, setB);

  return diff.size === 0;
}

export interface NodeInfo {
  name: string,
  number: number,
  domain_urls: Array<string>,
  direct_urls: Array<string>,
  key: Uint8Array | string
}

export class Node {
  id: string | undefined;
  key: PublicKey | undefined;
  name: string;
  http: string;
  https: string;
  ready: Promise<void>;
  keyBIN: Uint8Array;
  number: number;
  domainURLs: Set<string>;
  directURLs: Set<string>;

  constructor(info: NodeInfo) {
    if (!info || typeof info !== "object") throw new Error("invalid node: expected an object");
    if (typeof info.name !== "string" || info.name.length === 0)
      throw new Error("invalid node: name must be a non-empty string");
    if (!Number.isInteger(info.number) || info.number < 0)
      throw new Error(`invalid node ${info.name}: number must be a non-negative integer`);
    if (!Array.isArray(info.domain_urls) || info.domain_urls.length === 0 ||
        info.domain_urls.some(url => typeof url !== "string" || url.length === 0))
      throw new Error(`invalid node ${info.name}: domain_urls must be a non-empty string array`);
    if (!Array.isArray(info.direct_urls) ||
        info.direct_urls.some(url => typeof url !== "string" || url.length === 0))
      throw new Error(`invalid node ${info.name}: direct_urls must be a string array`);
    if (!(typeof info.key === "string" && info.key.length > 0) && !(info.key instanceof Uint8Array))
      throw new Error(`invalid node ${info.name}: key must be base64 or Uint8Array`);

    info.domain_urls.forEach(url => validateNodeURL(url, info.name, "domain_urls"));
    info.direct_urls.forEach(url => validateNodeURL(url, info.name, "direct_urls"));

    this.name = info.name;
    this.number = info.number;
    this.domainURLs = new Set(info.domain_urls);
    this.directURLs = new Set(info.direct_urls);

    let keyBIN = info.key;
    if (typeof keyBIN === "string") keyBIN = decode64(keyBIN);

    this.keyBIN = keyBIN as Uint8Array;

    const self = this;

    this.ready = PublicKey.unpack(this.keyBIN).then(key => {
      self.key = key;
      self.id = encode64(key.fingerprint);
    });

    const domainURL = this.domainURLs.values().next().value;

    if (this.directURLs.size)
      this.http = this.directURLs.values().next().value;
    else
      this.http = forceHTTP(domainURL);

    this.https = forceHTTPS(domainURL);
  }

  async getId() {
    await this.ready;

    return this.id;
  }

  async getPublicKey() {
    await this.ready;

    return this.key;
  }

  async equals(node: Node) {
    await this.ready;

    if (node.name !== this.name) return false;
    if (node.number !== this.number) return false;
    if (await node.getId() !== await this.getId()) return false;
    if (!isEqual(this.domainURLs, node.domainURLs)) return false;
    if (!isEqual(this.directURLs, node.directURLs)) return false;

    return true;
  }

  info() {
    return {
      name: this.name,
      number: this.number,
      domain_urls: Array.from(this.domainURLs),
      direct_urls: Array.from(this.directURLs),
      key: encode64(this.keyBIN)
    };
  }

  async getTopology(directConnection?: boolean) {
    await this.ready;

    let url = this.https;
    if (directConnection) url = this.http;

    const resp = await NodeConnection.request("GET", `${url}/topology`, {
      timeout: GET_TOPOLOGY_TIMEOUT
    });
    const { signature, packed_data: packed } = resp;
    if (!this.key) throw new Error("node initialization failed (key is undefined)");
    const isVerified = await this.key.verifyExtended(signature, packed);

    if (!isVerified) throw new Error("node signature mismatch");

    return boss.load(packed);
  }
}
