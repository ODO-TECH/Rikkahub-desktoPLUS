// Cold-start profiler: attaches to the shell's WebView2 over CDP and reports
// where the launch wall-clock actually goes. Run: node cdp-startup.js <processStartEpochMs>
const PORT = 9333;
const t0 = Number(process.argv[2]);
const at = (label) => console.log(String(label).padEnd(34) + ((Date.now() - t0) / 1000).toFixed(2) + " s");

async function waitJson(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("no " + url + " :: " + last);
}

const PROBE = `(function(){
  var brand = document.querySelector('img[src="/app-icon.png"]');
  var paints = performance.getEntriesByType("paint").map(function(p){return p.name+"="+Math.round(p.startTime)}).join(",");
  var n = performance.getEntriesByType("navigation")[0];
  var nav = n ? {navType:n.type, ttfb:Math.round(n.responseStart), domContentLoaded:Math.round(n.domContentLoadedEventEnd), load:Math.round(n.loadEventEnd)} : null;
  return {href:location.href, brand:!!brand, bodyChars:(document.body.innerText||"").replace(/\\s+/g," ").slice(0,60), paints:paints, nav:nav};
})()`;

const RES = `(function(){
  var rs = performance.getEntriesByType("resource");
  var wire = 0, dec = 0;
  rs.forEach(function(r){ wire += r.encodedBodySize || 0; dec += r.decodedBodySize || 0; });
  return {
    resources: rs.length,
    wireBytes: wire,
    decodedBytes: dec,
    anyCompression: wire < dec * 0.95,
    biggest: rs.map(function(r){return {n:r.name.split("/").pop().slice(0,36), enc:r.encodedBodySize, dec:r.decodedBodySize, dur:Math.round(r.duration)}}).sort(function(a,b){return b.dec-a.dec}).slice(0,7)
  };
})()`;

const main = async () => {
  const targets = await waitJson(`http://127.0.0.1:${PORT}/json/list`, 40000);
  at("first CDP target visible");
  const pages = targets.filter((t) => t.type === "page");
  console.log("targets:", pages.map((p) => p.url.slice(0, 60)).join("  |  "));
  const pick = pages[pages.length - 1];
  const ws = new WebSocket(pick.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  at("CDP attached");

  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend.has(msg.id)) {
      const { res, rej } = pend.get(msg.id);
      pend.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  const ev = async (expression) => {
    try {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true });
      return r.result && r.result.value;
    } catch (e) {
      return null;
    }
  };

  let last = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    last = await ev(PROBE);
    if (last && last.brand) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  at("UI mounted (brand icon in DOM)");
  console.log(JSON.stringify(last, null, 1));

  await new Promise((r) => setTimeout(r, 3000));
  const after = await ev(PROBE);
  at("+3 s later");
  console.log("nav now:", JSON.stringify(after && after.nav), "paints:", after && after.paints);
  console.log("body:", after && after.bodyChars);
  console.log("resources:", JSON.stringify(await ev(RES)));
  ws.close();
  process.exit(0);
};

main().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
