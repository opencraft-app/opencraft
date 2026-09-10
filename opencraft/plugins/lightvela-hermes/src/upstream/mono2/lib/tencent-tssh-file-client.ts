// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { Binary, serialize } from "bson";
import type { BotTerminalSession } from "../domain/types";
import { decodeTencentPtyFrame, extractTencentPtyError } from "./tencent-pty-client";

const DEFAULT_TAT_FILE_TIMEOUT_SECONDS = 3600;
const DEFAULT_TSSH_START_DELAY_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const EXEC_REQUEST_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_UPLOAD_CHUNK_BYTES = 256 * 1024;
const DEFAULT_READ_SIZE_BYTES = 1024 * 1024;

type TsshFileConnectionState = "idle" | "connecting" | "authenticating" | "starting" | "ready" | "closed" | "error";

type PendingRequest =
  | {
      kind: "list";
      resolve: (files: TsshFileInfo[]) => void;
      reject: (error: Error) => void;
      timer: number;
      files: TsshFileInfo[];
    }
  | {
      kind: "read";
      resolve: (chunks: TsshReadFileChunk[]) => void;
      reject: (error: Error) => void;
      timer: number;
      chunks: TsshReadFileChunk[];
    }
  | {
      kind: "single";
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  | {
      kind: "exec";
      resolve: (result: TsshExecCommandResult) => void;
      reject: (error: Error) => void;
      timer: number;
      chunks: Uint8Array[];
    };

export interface TsshFileClientOptions {
  channelId?: string;
  userName?: string;
  startDelayMs?: number;
  requestTimeoutMs?: number;
  uploadChunkBytes?: number;
  readSizeBytes?: number;
  WebSocketImpl?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  onStateChange?: (state: TsshFileConnectionState) => void;
  onError?: (message: string) => void;
  onClose?: (event: CloseEvent) => void;
}

export interface TsshFileInfo {
  type: "-" | "d" | "l" | "p" | string;
  name: string;
  size: number;
  modifyTime: number;
  accessTime: number;
  owner?: number;
  group?: number;
  rights?: string;
  longname?: string;
}

export interface TsshReadFileChunk {
  data: Uint8Array;
  offset: number;
  length: number;
  isLast: boolean;
}

export interface TsshDownloadProgress {
  receivedBytes: number;
  chunks: number;
}

export interface TsshUploadProgress {
  sentBytes: number;
  totalBytes: number;
  chunks: number;
}

export interface TsshExecCommandResult {
  exitCode: number | null;
  output: string;
}

export interface TsshDownloadChunkSink {
  write(chunk: Uint8Array, offset: number): Promise<void> | void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const asNumber = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const normalizeBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value instanceof Binary) {
    return value.buffer;
  }
  if (isRecord(value) && value.buffer instanceof Uint8Array) {
    return value.buffer;
  }
  return new Uint8Array();
};

const concatBytes = (chunks: Uint8Array[]) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const normalizeFileInfo = (value: unknown): TsshFileInfo | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    type: asString(value.Type, "-"),
    name: asString(value.Name),
    size: asNumber(value.Size),
    modifyTime: asNumber(value.ModifyTime),
    accessTime: asNumber(value.AccessTime),
    owner: typeof value.Owner === "number" ? value.Owner : undefined,
    group: typeof value.Group === "number" ? value.Group : undefined,
    rights: typeof value.Rights === "string" ? value.Rights : undefined,
    longname: typeof value.Longname === "string" ? value.Longname : undefined,
  };
};

const getFrameType = (message: unknown) => (isRecord(message) && typeof message.Type === "string" ? message.Type : "");

const getEnvelope = (message: unknown) => (isRecord(message) && isRecord(message.Data) ? message.Data : null);

const getPayload = (message: unknown) => {
  const envelope = getEnvelope(message);
  return envelope && isRecord(envelope.Data) ? envelope.Data : null;
};

const getCustomData = (message: unknown) => {
  const envelope = getEnvelope(message);
  return envelope && typeof envelope.CustomData === "string" ? envelope.CustomData : "";
};

const makeRequestId = () => `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

const execRequestTimeoutMs = (timeoutSeconds: number, fallbackTimeoutMs: number) => {
  const commandTimeoutMs = Math.max(0, timeoutSeconds) * 1000 + EXEC_REQUEST_TIMEOUT_BUFFER_MS;
  return Math.max(fallbackTimeoutMs, commandTimeoutMs);
};

export const joinTsshPath = (basePath: string, name: string) => {
  const base = basePath.trim() || "/";
  if (base === "/") {
    return `/${name}`;
  }
  return `${base.replace(/\/+$/, "")}/${name}`;
};

export const parentTsshPath = (path: string) => {
  const normalized = path.trim() || "/";
  if (normalized === "/") {
    return "/";
  }
  const trimmed = normalized.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return trimmed.slice(0, index);
};

export class TencentTsshFileClient {
  private socket: WebSocket | null = null;
  private startTimer: number | null = null;
  private state: TsshFileConnectionState = "idle";
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly channelId: string;
  private readonly userName: string;
  private readonly startDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly uploadChunkBytes: number;
  private readonly readSizeBytes: number;
  private readonly WebSocketImpl: new (url: string | URL, protocols?: string | string[]) => WebSocket;

  constructor(
    private readonly bootstrap: BotTerminalSession,
    private readonly options: TsshFileClientOptions = {},
  ) {
    this.channelId = options.channelId ?? `file-${bootstrap.sessionId}`;
    this.userName = options.userName ?? "";
    this.startDelayMs = options.startDelayMs ?? DEFAULT_TSSH_START_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadChunkBytes = options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    this.readSizeBytes = options.readSizeBytes ?? DEFAULT_READ_SIZE_BYTES;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.setState("connecting");

    const socket = new this.WebSocketImpl(this.bootstrap.wsUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.setState("authenticating");
      this.sendJson({
        Type: "SessionAuth",
        Data: {
          Uin: this.bootstrap.ownerUin,
          AppId: this.bootstrap.appId,
          InstanceId: this.bootstrap.instanceId,
          SessionId: this.bootstrap.sessionId,
        },
      });

      this.startTimer = window.setTimeout(() => {
        this.startTimer = null;
        this.startFileChannel();
      }, this.startDelayMs);
    };

    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };

    socket.onerror = () => {
      this.fail(new Error("websocket error"));
    };

    socket.onclose = (event) => {
      this.clearStartTimer();
      this.socket = null;
      if (this.state !== "error") {
        this.setState("closed");
      }
      this.options.onClose?.(event);
    };

    return this.readyPromise;
  }

  isReady() {
    return this.state === "ready" && this.socket?.readyState === WebSocket.OPEN;
  }

  async listPath(path: string, filter = "*", showHidden = true) {
    await this.connect();
    return this.sendListRequest("PtyListPath", {
      Path: path,
      Filter: filter,
      ShowHidden: showHidden,
    });
  }

  async createFile(path: string, input: { mode?: number; overwrite?: boolean; isDir?: boolean } = {}) {
    await this.connect();
    const payload = await this.sendSingleRequest("PtyCreateFile", {
      Path: path,
      Mode: input.mode ?? 0o644,
      Overwrite: input.overwrite ?? false,
      IsDir: input.isDir ?? false,
    });
    return isRecord(payload) && payload.Created === true;
  }

  async deleteFile(path: string, isDir: boolean) {
    await this.connect();
    const payload = await this.sendSingleRequest("PtyDeleteFile", {
      Path: path,
      IsDir: isDir,
    });
    return isRecord(payload) && payload.Deleted === true;
  }

  async execCommand(cmd: string, timeout = 60) {
    await this.connect();
    const timeoutSeconds = Math.max(0, timeout);
    return this.sendExecRequest("PtyExecCmdStream", {
      Cmd: cmd,
      Timeout: timeoutSeconds,
    }, execRequestTimeoutMs(timeoutSeconds, this.requestTimeoutMs));
  }

  async fileInfo(path: string) {
    await this.connect();
    const payload = await this.sendSingleRequest("PtyFileInfo", { Path: path });
    return normalizeFileInfo(payload);
  }

  async fileExists(path: string) {
    await this.connect();
    const payload = await this.sendSingleRequest("PtyFileExist", { Path: path });
    return isRecord(payload) && payload.Exists === true;
  }

  async readFile(path: string, offset = 0, size = this.readSizeBytes) {
    await this.connect();
    return this.sendReadRequest("PtyReadFile", {
      Path: path,
      Offset: offset,
      Size: size,
    });
  }

  async downloadFile(path: string, onProgress?: (progress: TsshDownloadProgress) => void) {
    const parts: Uint8Array[] = [];
    await this.downloadFileToSink(path, {
      write: (chunk) => {
        parts.push(chunk.slice());
      },
    }, onProgress);

    return new Blob(parts.map((part) => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer));
  }

  async downloadFileToStream(path: string, stream: WritableStream<Uint8Array>, onProgress?: (progress: TsshDownloadProgress) => void) {
    const writer = stream.getWriter();
    try {
      await this.downloadFileToSink(path, {
        write: (chunk) => writer.write(chunk),
      }, onProgress);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }

  async downloadFileToSink(path: string, sink: TsshDownloadChunkSink, onProgress?: (progress: TsshDownloadProgress) => void) {
    let offset = 0;
    let chunks = 0;

    while (true) {
      const responseChunks = await this.readFile(path, offset, this.readSizeBytes);
      if (responseChunks.length === 0) {
        break;
      }
      let batchBytes = 0;
      for (const chunk of responseChunks) {
        if (chunk.length > 0) {
          const data = chunk.data.byteLength === chunk.length ? chunk.data : chunk.data.slice(0, chunk.length);
          await sink.write(data, chunk.offset);
        }
        batchBytes += chunk.length;
        chunks += 1;
        offset = chunk.offset + chunk.length;
        onProgress?.({ receivedBytes: offset, chunks });
      }

      if (batchBytes === 0 || batchBytes < this.readSizeBytes) {
        break;
      }
    }
  }

  async writeFile(path: string, data: Uint8Array, offset?: number) {
    await this.connect();
    const payload = await this.sendSingleRequest("PtyWriteFile", {
      Path: path,
      Offset: offset,
      Data: new Binary(data),
    });
    return isRecord(payload) ? asNumber(payload.Length) : 0;
  }

  async uploadFile(path: string, file: File, onProgress?: (progress: TsshUploadProgress) => void) {
    await this.createFile(path, { overwrite: true, isDir: false });

    let offset = 0;
    let chunks = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + this.uploadChunkBytes);
      const data = new Uint8Array(await slice.arrayBuffer());
      const written = await this.writeFile(path, data, offset);
      offset += written;
      chunks += 1;
      onProgress?.({ sentBytes: offset, totalBytes: file.size, chunks });
      if (written !== data.length) {
        throw new Error(`short write: wrote ${written} of ${data.length} bytes`);
      }
    }
  }

  close() {
    this.clearStartTimer();
    for (const [id, request] of this.pending) {
      window.clearTimeout(request.timer);
      request.reject(new Error("file channel closed"));
      this.pending.delete(id);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendJson({
        Type: "PtyStop",
        Data: {
          SessionId: this.bootstrap.sessionId,
          ChannelId: this.channelId,
        },
      });
    }
    this.socket?.close();
    this.socket = null;
  }

  private startFileChannel() {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.setState("starting");
    this.sendJson({
      Type: "PtyStart",
      Data: {
        SessionId: this.bootstrap.sessionId,
        ChannelId: this.channelId,
        UserName: this.userName,
        Cols: this.bootstrap.cols,
        Rows: this.bootstrap.rows,
        NoShell: true,
        MaxIdleTime: this.bootstrap.timeoutSeconds ?? DEFAULT_TAT_FILE_TIMEOUT_SECONDS,
      },
    });
  }

  private sendListRequest(type: string, data: Record<string, unknown>) {
    return new Promise<TsshFileInfo[]>((resolve, reject) => {
      const requestId = this.trackPending({
        kind: "list",
        resolve,
        reject,
        timer: 0,
        files: [],
      });
      this.sendBson(type, requestId, data);
    });
  }

  private sendReadRequest(type: string, data: Record<string, unknown>) {
    return new Promise<TsshReadFileChunk[]>((resolve, reject) => {
      const requestId = this.trackPending({
        kind: "read",
        resolve,
        reject,
        timer: 0,
        chunks: [],
      });
      this.sendBson(type, requestId, data);
    });
  }

  private sendSingleRequest(type: string, data: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      const requestId = this.trackPending({
        kind: "single",
        resolve,
        reject,
        timer: 0,
      });
      this.sendBson(type, requestId, data);
    });
  }

  private sendExecRequest(type: string, data: Record<string, unknown>, timeoutMs: number) {
    return new Promise<TsshExecCommandResult>((resolve, reject) => {
      const requestId = this.trackPending({
        kind: "exec",
        resolve,
        reject,
        timer: 0,
        chunks: [],
      }, timeoutMs);
      this.sendBson(type, requestId, data);
    });
  }

  private trackPending(request: PendingRequest, timeoutMs = this.requestTimeoutMs) {
    const requestId = makeRequestId();
    request.timer = window.setTimeout(() => {
      this.pending.delete(requestId);
      request.reject(new Error("TAT file request timed out"));
    }, timeoutMs);
    this.pending.set(requestId, request);
    return requestId;
  }

  private async handleMessage(data: string | Blob | ArrayBuffer) {
    try {
      const message = await decodeTencentPtyFrame(data);
      const type = getFrameType(message);

      if (type === "PtyReady") {
        this.setState("ready");
        this.resolveReady?.();
        return;
      }

      if (type === "PtyError" || type === "Error") {
        this.fail(new Error(extractTencentPtyError(message)));
        return;
      }

      this.handleBsonResponse(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleBsonResponse(message: unknown) {
    const customData = getCustomData(message);
    if (!customData) {
      return;
    }

    const request = this.pending.get(customData);
    if (!request) {
      return;
    }

    const payload = getPayload(message);
    if (payload?.Error && typeof payload.Error === "string") {
      this.rejectPending(customData, request, new Error(payload.Error));
      return;
    }

    switch (request.kind) {
      case "list": {
        const files = Array.isArray(payload?.Files) ? payload.Files : [];
        for (const file of files) {
          const normalized = normalizeFileInfo(file);
          if (normalized) {
            request.files.push(normalized);
          }
        }
        if (payload?.IsLast === true) {
          this.resolvePending(customData, request, request.files);
        }
        return;
      }
      case "read": {
        request.chunks.push({
          data: normalizeBytes(payload?.Data),
          offset: asNumber(payload?.Offset),
          length: asNumber(payload?.Length),
          isLast: payload?.IsLast === true,
        });
        if (payload?.IsLast === true) {
          this.resolvePending(customData, request, request.chunks);
        }
        return;
      }
      case "single": {
        this.resolvePending(customData, request, payload);
        return;
      }
      case "exec": {
        const data = normalizeBytes(payload?.Data);
        if (data.byteLength > 0) {
          request.chunks.push(data.slice());
        }
        if (payload?.IsLast === true) {
          const output = new TextDecoder().decode(concatBytes(request.chunks));
          this.resolvePending(customData, request, {
            exitCode: typeof payload.ExitCode === "number" ? payload.ExitCode : null,
            output,
          });
        }
        return;
      }
    }
  }

  private resolvePending<T>(requestId: string, request: PendingRequest, value: T) {
    window.clearTimeout(request.timer);
    this.pending.delete(requestId);
    if (request.kind === "single") {
      request.resolve(value);
    } else {
      request.resolve(value as never);
    }
  }

  private rejectPending(requestId: string, request: PendingRequest, error: Error) {
    window.clearTimeout(request.timer);
    this.pending.delete(requestId);
    request.reject(error);
  }

  private sendBson(type: string, customData: string, data: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("file channel is not connected");
    }
    this.socket.send(
      serialize({
        Type: type,
        Data: {
          SessionId: this.bootstrap.sessionId,
          ChannelId: this.channelId,
          CustomData: customData,
          Data: data,
        },
      }),
    );
  }

  private sendJson(frame: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private fail(error: Error) {
    this.clearStartTimer();
    this.setState("error");
    this.rejectReady?.(error);
    this.options.onError?.(error.message);
  }

  private clearStartTimer() {
    if (this.startTimer === null) {
      return;
    }
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private setState(state: TsshFileConnectionState) {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
