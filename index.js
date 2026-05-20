// sigma.js
// =====================
// USB display driver: captures a screenshot from a headless
// browser, converts RGB to YUV422, and streams to a USB
// monitor device.  Runs at HZ frames per second.
// =====================

const usb = require("usb");
const puppeteer = require("puppeteer");
const sharp = require("sharp");
const si = require("systeminformation");
const readline = require("readline");

// ---------- CONFIGURATION ----------
const WIDTH = 480; // display width
const HEIGHT = 480; // display height
const VID = 0x534d; // vendor ID
const PID = 0x6021; // product ID
const HZ = 24; // frame rate

const URL = `file:///home/daniel176/Documents/ms912x-projecting/index.html`;

const MODE = 0x8100; // mode register
const PIXFMT = 0x2200; // pixel format

// ---------- GLOBAL ERROR HANDLING ----------
process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled rejection:", reason);
  if (reason && reason.message === "LIBUSB_TRANSFER_ERROR") {
    console.error("[HINT] LIBUSB_TRANSFER_ERROR = USB transfer failed. This could mean:");
    console.error("  - The device was disconnected or is unstable");
    console.error("  - The adapter does not support the configured resolution/framerate");
    console.error("  - A previous run left the device in a bad state; try unplug/replug");
  }
});

// ---------- STATE ----------
let device = null;
let outEndpoint = null;
let running = true;
let reloadRequested = false;

// ---------- USB HELPERS ----------
function getDevice() {
  const dev = usb.findByIds(VID, PID);
  if (!dev) throw new Error("Device not found");
  try {
    dev.open();
  } catch (err) {
    if (err.message.includes("LIBUSB_ERROR_ACCESS")) {
      console.error("\n------------------------------------------------------------------");
      console.error("ERROR: USB Access Denied (LIBUSB_ERROR_ACCESS)");
      console.error("The script does not have permission to access the USB adapter.");
      console.error("\nHow to fix:");
      console.error("1. Run with sudo: sudo node index.js");
      console.error("2. OR create a udev rule:");
      console.error("   echo 'SUBSYSTEM==\"usb\", ATTR{idVendor}==\"534d\", ATTR{idProduct}==\"6021\", MODE=\"0666\", GROUP=\"users\"' | sudo tee /etc/udev/rules.d/99-ms912x.rules");
      console.error("   sudo udevadm control --reload-rules && sudo udevadm trigger")
      console.error("   Then run: sudo udevadm control --reload-rules && sudo udevadm trigger");
      console.error("   And replug the device.");
      console.error("------------------------------------------------------------------\n");
      process.exit(1);
    }
    throw err;
  }
  // Claim interfaces 0 and 3
  [0, 3].forEach((idx) => {
    const iface = dev.interface(idx);
    if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    if (!iface.isClaimed) iface.claim();
  });
  return dev;
}

function getEndpoint(dev) {
  const iface = dev.interface(3);
  const ep = iface.endpoints.find((e) => e.direction === "out");
  if (!ep) throw new Error("OUT endpoint not found");
  return ep;
}

function ctrlTransfer(...args) {
  return new Promise((resolve, reject) =>
    device.controlTransfer(...args, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );
}

async function readReg(address) {
  const buf = Buffer.from([0xb5, address >> 8, address & 0xff]);
  await ctrlTransfer(0x21, 0x09, 0x0300, 0, buf);
  const resp = await ctrlTransfer(0xa1, 0x01, 0x0300, 0, 8);
  return resp[3];
}

async function write6(address, data6) {
  const pkt = Buffer.alloc(8, 0);
  pkt[0] = 0xa6;
  pkt[1] = address;
  for (let i = 0; i < 6; i++) pkt[2 + i] = data6[i] || 0;
  await ctrlTransfer(0x21, 0x09, 0x0300, 0, pkt);
}

// ---------- DEVICE CONTROL ----------
async function powerOn() {
  await write6(0x07, [1, 2, 0, 0, 0, 0]);
}

async function setResolution() {
  await write6(0x04, [0, 0, 0, 0, 0, 0]);
  await readReg(0x30);
  await readReg(0x33);
  await readReg(0xc620);
  await write6(0x03, [3, 0, 0, 0, 0, 0]);

  const resolution = [
    WIDTH >> 8,
    WIDTH & 0xff,
    HEIGHT >> 8,
    HEIGHT & 0xff,
    PIXFMT >> 8,
    PIXFMT & 0xff,
  ];
  await write6(0x01, resolution);

  const modeData = [
    MODE >> 8,
    MODE & 0xff,
    WIDTH >> 8,
    WIDTH & 0xff,
    HEIGHT >> 8,
    HEIGHT & 0xff,
  ];
  await write6(0x02, modeData);

  await write6(0x04, [1, 0, 0, 0, 0, 0]);
  await write6(0x05, [1, 0, 0, 0, 0, 0]);
}

async function initDevice(attempts = 2, doReset = false) {
  if (doReset && device) {
    device.reset(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    device = null;
  }

  device = getDevice();
  outEndpoint = getEndpoint(device);

  await powerOn();
  await setResolution();

  if (attempts === 2) {
    await new Promise((r) => setTimeout(r, 1000));
    device = getDevice();
    await powerOn();
    await setResolution();
  }
}

// ---------- IMAGE HELPERS ----------
function rgbToYuv422(buf) {
  const size = WIDTH * HEIGHT;
  const out = Buffer.allocUnsafe(size * 2);

  for (let i = 0; i < size; i++) {
    const r = buf[3 * i];
    const g = buf[3 * i + 1];
    const b = buf[3 * i + 2];

    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const uv =
      i & 1
        ? 0.5 * r - 0.41869 * g - 0.08131 * b + 128
        : -0.16874 * r - 0.33126 * g + 0.5 * b + 128;

    out[2 * i] = Math.max(0, Math.min(255, uv));
    out[2 * i + 1] = Math.max(0, Math.min(255, y));
  }

  return out;
}

function buildFrame(yuv) {
  const header = Buffer.from([
    0xff,
    0,
    0,
    0,
    0,
    Math.floor(WIDTH / 16),
    HEIGHT >> 8,
    HEIGHT & 0xff,
  ]);
  const footer = Buffer.from([0xff, 0xc0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, yuv, footer]);
}

// ---------- MAIN ----------
(async () => {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on("keypress", (_, key) => {
    if (key.ctrl && key.name === "c") running = false;
    if (key.name === "r") reloadRequested = true;
  });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      `--window-size=${WIDTH},${HEIGHT}`,
      "--hide-scrollbars",
      "--disable-infobars",
    ],
    defaultViewport: { width: WIDTH, height: HEIGHT },
  });
  const page = await browser.newPage();

  console.log(`[INFO] Opening ${URL}`);
  await page.goto(URL);
  console.log(`[OK] Success ${URL}`);

  console.log("[INFO] Initializing USB device...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await initDevice();
      console.log("[OK] Device initialized.");
      break;
    } catch (err) {
      console.error(`[ERROR] Attempt ${attempt}/3: Failed to initialize USB device:`, err.message);
      if (attempt === 3) {
        if (err.message === "Device not found") {
          console.error("[HINT] Is the USB adapter plugged in? Check with: lsusb | grep 534d");
        } else if (err.message.includes("LIBUSB")) {
          console.error("[HINT] Try unplugging and re-plugging the adapter.");
        }
        running = false;
      } else {
        console.log(`[INFO] Retrying in 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  const frameInterval = 1000 / HZ;

  while (running) {
    const start = Date.now();

    if (reloadRequested) {
      await page.reload();
      reloadRequested = false;
    }

    const cpu = await si.currentLoad();
    const cpuStr = cpu.currentLoad.toFixed(1);
    await page.evaluate((c) => {
      const el = document.getElementById("cpu");
      const w = document.getElementById("cpu-wrapper");
      if (el) el.textContent = c;
      if (w) w.dataset.text = `CPU: ${c}%`;
    }, cpuStr);

    const png = await page.screenshot({ encoding: "binary" });
    const raw = await sharp(png).removeAlpha().raw().toBuffer();
    const yuv = rgbToYuv422(raw);
    const frame = buildFrame(yuv);

    await new Promise(
      (resolve, reject) =>
        outEndpoint &&
        outEndpoint.transfer(frame, (err) => (err ? reject(err) : resolve())),
    );

    const elapsed = Date.now() - start;
    if (elapsed < frameInterval)
      await new Promise((r) => setTimeout(r, frameInterval - elapsed));
  }

  // Send black frame before exit
  if (outEndpoint) {
    const black = Buffer.alloc(WIDTH * HEIGHT * 3, 0);
    outEndpoint.transfer(buildFrame(rgbToYuv422(black)), () => {});
  }

  await browser.close();
  process.exit();
})();
