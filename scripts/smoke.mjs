import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const rootDir = resolve(import.meta.dirname, "..");
const apiPort = Number(process.env.SMOKE_API_PORT ?? 8080);
const dashboardPort = Number(process.env.SMOKE_DASHBOARD_PORT ?? 20581);
const apiUrl = (
  process.env.SMOKE_API_URL ?? `http://127.0.0.1:${apiPort}`
).replace(/\/+$/, "");
const dashboardUrl = (
  process.env.SMOKE_DASHBOARD_URL ?? `http://127.0.0.1:${dashboardPort}/`
).replace(/\/+$/, "");
const startupTimeoutMs = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS ?? 30000);
const explicitlyTargeted =
  Boolean(process.env.SMOKE_API_URL) ||
  Boolean(process.env.SMOKE_DASHBOARD_URL);

const startedServices = [];

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function request(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function isReachable(url) {
  try {
    const response = await request(url);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(label, check) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = "not reachable";

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = formatError(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  throw new Error(`${label} did not become ready: ${lastError}`);
}

function rememberOutput(service, chunk) {
  service.output += chunk.toString();
  if (service.output.length > 8000) {
    service.output = service.output.slice(-8000);
  }
}

function startService({ label, packageName, port, extraEnv, probeUrl }) {
  const child = spawn(
    "pnpm",
    ["--filter", packageName, "run", "dev"],
    {
      cwd: rootDir,
      detached: true,
      env: {
        ...process.env,
        ...extraEnv,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const service = { child, label, output: "" };
  child.stdout.on("data", (chunk) => rememberOutput(service, chunk));
  child.stderr.on("data", (chunk) => rememberOutput(service, chunk));
  startedServices.push(service);

  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      rememberOutput(service, `\nprocess exited with code ${code}\n`);
    } else if (signal) {
      rememberOutput(service, `\nprocess exited with signal ${signal}\n`);
    }
  });

  return waitFor(`${label} at ${probeUrl}`, async () => {
    if (child.exitCode !== null) {
      throw new Error(
        `${label} exited before becoming ready:\n${service.output}`,
      );
    }
    return isReachable(probeUrl);
  }).catch((error) => {
    throw new Error(`${error.message}\n${service.output}`);
  });
}

async function ensureService(options) {
  if (await isReachable(options.probeUrl)) {
    console.log(`Using running ${options.label}: ${options.probeUrl}`);
    return;
  }

  if (explicitlyTargeted) {
    throw new Error(
      `${options.label} is not reachable at ${options.probeUrl}. ` +
        "Remove the explicit SMOKE_*_URL override to let the smoke check start local services.",
    );
  }

  console.log(`Starting ${options.label} on port ${options.port}…`);
  await startService(options);
}

async function checkApiHealth() {
  const healthUrl = `${apiUrl}/api/healthz`;
  const response = await request(healthUrl);
  if (!response.ok) {
    throw new Error(`API health check returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body?.status !== "ok") {
    throw new Error(`API health check returned an unexpected body: ${JSON.stringify(body)}`);
  }

  console.log(`API health passed: ${healthUrl}`);
}

function findBrowserExecutable() {
  const candidates = [
    process.env.SMOKE_BROWSER_PATH,
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      "Chromium was not found. Set SMOKE_BROWSER_PATH to a Chromium executable.",
    );
  }
  return executablePath;
}

async function checkDashboard() {
  const browser = await chromium.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const browserErrors = [];
  const failedRequests = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "request failed"}`,
    );
  });

  // The dashboard uses relative /api URLs. Route those requests to the API
  // service when the smoke check is running the two artifacts on local ports.
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const targetUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      `${apiUrl}/`,
    );
    await route.continue({ url: targetUrl.toString() });
  });

  try {
    const response = await page.goto(dashboardUrl, {
      timeout: startupTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    if (!response || !response.ok()) {
      throw new Error(
        `Dashboard root returned HTTP ${response?.status() ?? "no response"}`,
      );
    }

    await page.getByRole("heading", { name: "Дашборд" }).waitFor({
      state: "visible",
      timeout: startupTimeoutMs,
    });
    await page.waitForTimeout(500);

    if (browserErrors.length > 0 || failedRequests.length > 0) {
      const details = [
        ...browserErrors,
        ...failedRequests.map((failure) => `requestfailed: ${failure}`),
      ];
      throw new Error(`Dashboard browser errors:\n${details.join("\n")}`);
    }

    console.log(`Dashboard smoke passed: ${dashboardUrl}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function stopStartedServices() {
  for (const service of startedServices.reverse()) {
    if (service.child.exitCode !== null) continue;
    try {
      process.kill(-service.child.pid, "SIGTERM");
    } catch {
      service.child.kill("SIGTERM");
    }
  }
}

try {
  await ensureService({
    label: "API server",
    packageName: "@workspace/api-server",
    port: apiPort,
    probeUrl: `${apiUrl}/api/healthz`,
    extraEnv: {},
  });
  await ensureService({
    label: "dashboard",
    packageName: "@workspace/gpay-digiseller-sync",
    port: dashboardPort,
    probeUrl: dashboardUrl,
    extraEnv: { BASE_PATH: "/" },
  });
  await checkApiHealth();
  await checkDashboard();
} catch (error) {
  console.error(`Smoke check failed: ${formatError(error)}`);
  process.exitCode = 1;
} finally {
  await stopStartedServices();
}