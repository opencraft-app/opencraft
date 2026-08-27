import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const port = Number(process.env.FAKE_JIFEI_PORT || "19020");
const callbackURL =
  process.env.FAKE_JIFEI_CALLBACK_URL ||
  "http://trade.trade.svc.cluster.local/trade/jifei/callback";
const databasePath =
  process.env.FAKE_JIFEI_DATABASE_PATH || "/data/fake-jifei.sqlite";
mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS deals (
    deal_name TEXT PRIMARY KEY,
    order_json TEXT NOT NULL,
    fulfillment_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const upsertDeal = database.prepare(`
  INSERT INTO deals (
    deal_name, order_json, fulfillment_status, last_error, created_at, updated_at
  ) VALUES (?, ?, 'pending', NULL, ?, ?)
  ON CONFLICT(deal_name) DO UPDATE SET
    order_json = excluded.order_json,
    updated_at = excluded.updated_at
`);
const selectDeal = database.prepare(`
  SELECT order_json, fulfillment_status
  FROM deals
  WHERE deal_name = ?
`);
const updateFulfillment = database.prepare(`
  UPDATE deals
  SET fulfillment_status = ?, last_error = ?, updated_at = ?
  WHERE deal_name = ?
`);
const fulfillmentTasks = new Map();

function sendJSON(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function success(request, data) {
  return {
    version: request.version || "1.0",
    eventId: request.eventId || Date.now(),
    returnCode: 0,
    returnMessage: "success",
    data,
  };
}

function dealID(prefix) {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function rememberDeals(request, dealNames) {
  const para = request?.interface?.para || {};
  const goods = Array.isArray(para.goods) ? para.goods : [];
  for (const [index, dealName] of dealNames.entries()) {
    const now = Date.now();
    const order = {
      appId: para.appId,
      ownerUin: para.ownerUin,
      operateUin: para.uin,
      goods: goods[index] || goods[0],
    };
    upsertDeal.run(dealName, JSON.stringify(order), now, now);
  }
}

function loadDeal(dealName) {
  const row = selectDeal.get(dealName);
  if (!row) {
    return null;
  }
  return {
    order: JSON.parse(row.order_json),
    fulfillmentStatus: row.fulfillment_status,
  };
}

function setFulfillmentStatus(dealName, status, error = null) {
  updateFulfillment.run(status, error, Date.now(), dealName);
}

function callbackEnvelope(interfaceName, para) {
  const traceID = crypto.randomUUID().replaceAll("-", "");
  return {
    version: "1.0",
    componentName: "trade",
    caller: "fake-jifei",
    eventId: Date.now(),
    timestamp: Date.now(),
    seqId: traceID,
    spanId: traceID,
    interface: { interfaceName, para },
  };
}

function callbackPara(dealName, order) {
  const goods = order.goods || {};
  const goodsDetail = goods.goodsDetail || {};
  const common = {
    appId: order.appId,
    uin: order.ownerUin,
    subProductCode: goodsDetail.subProductCode,
    goodsDetail,
  };
  return {
    checkCreate: {
      ...common,
      operateUin: order.operateUin,
      region: goods.regionId,
      zoneId: goods.zoneId,
      payMode: goods.payMode,
      productCode: goodsDetail.productCode,
      projectId: goods.projectId || 0,
    },
    createResource: {
      ...common,
      dealName,
    },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function postCallback(interfaceName, para) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(callbackURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackEnvelope(interfaceName, para)),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (!response.ok || body.returnCode !== 0 || body.returnValue !== 0) {
        throw new Error(
          `status=${response.status} returnCode=${body.returnCode} returnValue=${body.returnValue} message=${body.returnMessage || ""}`,
        );
      }
      console.log(
        `fake jifei callback interface=${interfaceName} returnCode=0`,
      );
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await sleep(attempt * 250);
      }
    }
  }
  throw lastError;
}

async function fulfillDeal(dealName) {
  const storedDeal = loadDeal(dealName);
  if (storedDeal?.fulfillmentStatus === "completed") {
    return;
  }
  if (!storedDeal) {
    throw new Error(`unknown dealName=${dealName}`);
  }
  const { order } = storedDeal;
  const para = callbackPara(dealName, order);
  await postCallback("lightvela.pass.checkCreate", para.checkCreate);
  await postCallback("lightvela.pass.createResource", para.createResource);
  setFulfillmentStatus(dealName, "completed");
  console.log(`fake jifei fulfilled dealName=${dealName}`);
}

function queueFulfillment(dealNames) {
  for (const dealName of dealNames) {
    const storedDeal = loadDeal(dealName);
    if (
      storedDeal?.fulfillmentStatus === "completed" ||
      fulfillmentTasks.has(dealName)
    ) {
      continue;
    }
    const task = fulfillDeal(dealName)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (storedDeal) {
          setFulfillmentStatus(dealName, "failed", message);
        }
        console.error(
          `fake jifei fulfillment failed dealName=${dealName}: ${message}`,
        );
      })
      .finally(() => {
        fulfillmentTasks.delete(dealName);
      });
    fulfillmentTasks.set(dealName, task);
  }
}

function responseData(request) {
  const interfaceName = request?.interface?.interfaceName || "";
  const para = request?.interface?.para || {};

  switch (interfaceName) {
    case "qcloud.price.getPrice":
      return (para.resInfo || []).map((item) => ({
        price: "99.00",
        totalCost: "99.00",
        realTotalCost: "79.00",
        currency: item.currency || "CNY",
        timeUnit: item.goodsDetail?.timeUnit || "m",
        timeSpan: item.goodsDetail?.timeSpan || 1,
        goodsNum: item.goodsNum || 1,
        productCode: item.goodsDetail?.productCode || "p_lighthouse",
        subProductCode:
          item.goodsDetail?.subProductCode || "sp_lighthouse_local",
        pid: item.goodsDetail?.pid || 1000000,
        policyDetail: { total: 0.8, user: 0.9, common: 1 },
      }));
    case "qcloud.Deal.generateDeals": {
      const dealName = dealID("local-deal");
      rememberDeals(request, [dealName]);
      return {
        dealNames: [dealName],
        bigDealId: dealID("local-big"),
        priceInfos: [],
      };
    }
    case "qcloud.Deal.generateDealsAndPay": {
      const dealName = dealID("local-deal");
      const bigDealID = dealID("local-big");
      rememberDeals(request, [dealName]);
      return {
        dealNames: [dealName],
        bigDealIds: [bigDealID],
        dealIds: [dealID("local-id")],
        resourceIds: { [dealName]: [dealID("local-resource")] },
        dealDeliverResults: { [dealName]: { state: "0" } },
      };
    }
    case "qcloud.margin.getMidasEarmarking": {
      const billID = dealID("local-bill");
      return {
        billId: billID,
        url: `http://localhost:5173/subscribe?local_payment=${billID}`,
        appid: "local-midas",
        needCharge: 0,
        tokenId: dealID("local-token"),
        outTradeNo: billID,
        dealNames: para.dealNames || [],
        bigDealIds: [dealID("local-big")],
      };
    }
    case "qcloud.Deal.getDealsByKeyIndex":
      return {
        totalNum: "1",
        deals: [
          {
            dealName: para.cond?.dealName || dealID("local-deal"),
            bigDealId: dealID("local-big"),
            productCode: "p_lighthouse",
            subProductCode: "sp_lighthouse_local",
            status: 5,
          },
        ],
      };
    case "qcloud.Deal.OnlineRefund":
      return {
        dealNames: [dealID("local-refund")],
        bigDealIds: [dealID("local-refund-big")],
      };
    default:
      return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    sendJSON(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "method_not_allowed" });
    return;
  }

  try {
    const request = await readJSON(req);
    const interfaceName = request?.interface?.interfaceName || "";
    if (!interfaceName) {
      sendJSON(res, 400, {
        returnCode: 100001,
        returnMessage: "missing interface.interfaceName",
      });
      return;
    }
    console.log(`fake jifei interface=${interfaceName}`);
    const data = responseData(request);
    sendJSON(res, 200, success(request, data));
    if (
      interfaceName === "qcloud.margin.getMidasEarmarking" &&
      data.needCharge === 0
    ) {
      queueFulfillment(request.interface.para?.dealNames || []);
    }
  } catch (error) {
    sendJSON(res, 400, {
      returnCode: 100001,
      returnMessage: error instanceof Error ? error.message : "invalid request",
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`fake jifei listening on :${port}`);
});
