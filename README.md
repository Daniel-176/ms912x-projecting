# ms912x-projecting

USB display driver for MS912x-based portable monitors. Captures a headless browser screenshot (analog clock with CPU overlay), converts RGB to YUV422, and streams to the USB display at 24 fps.

## Requirements

- Node.js 18+
- USB device with VID `0x534d` / PID `0x6021` (MacroSilicon MS912x)
- Linux (udev-based USB permission system)

## Setup

```bash
npm install
```

## USB Permissions

To allow access without `sudo`, create a udev rule:

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="534d", ATTR{idProduct}=="6021", MODE="0666", GROUP="users"' \
  | sudo tee /etc/udev/rules.d/99-ms912x.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug and replug the device.

## Usage

```bash
node index.js
```

The script launches a headless Chromium browser rendering `index.html` (an analog clock), captures screenshots, and streams them to the USB display.

### Controls

| Key    | Action          |
|--------|-----------------|
| Ctrl+C | Stop streaming  |
| r      | Reload page     |

## Communication Protocol

The MS912x display adapter is controlled via USB control transfers and isochronous OUT endpoints.

### Device Info

- Vendor ID: `0x534d` (MacroSilicon)
- Product ID: `0x6021`
- Interfaces claimed: 0 (control), 3 (data OUT)
- OUT endpoint is found on interface 3

### Register Access

**Read register:**
- Send: `0xb5` + 16-bit address (3 bytes, control transfer bmRequestType=0x21, bRequest=0x09, wValue=0x0300)
- Receive: 8-byte response; value is in `resp[3]`

**Write 6 bytes:**
- Packet: `0xa6` + address byte + 6 data bytes (padded with zeros)
- Sent as control transfer (bmRequestType=0x21, bRequest=0x09, wValue=0x0300)

### Initialization Sequence

1. **Power on** — write `[1, 2, 0, 0, 0, 0]` to register `0x07`
2. **Set resolution** — sequence:
   - Clear register `0x04` with `[0,0,0,0,0,0]`
   - Read registers `0x30`, `0x33`, `0xc620`
   - Write `[3,0,0,0,0,0]` to register `0x03`
   - Write resolution (width hi/lo, height hi/lo, pixel format hi/lo) to register `0x01`
   - Write mode data (mode hi/lo, width hi/lo, height hi/lo) to register `0x02`
   - Write `[1,0,0,0,0,0]` to registers `0x04` and `0x05`

### Pixel Format

- Format register: `0x2200` (YUV422)
- Resolution: 480x480

### Frame Structure

Each frame sent to the OUT endpoint:

```
[8-byte header] [YUV422 data] [8-byte footer]
```

**Header:** `0xFF 0x00 0x00 0x00 0x00 <width/16> <height hi> <height lo>`

**Footer:** `0xFF 0xC0 0x00 0x00 0x00 0x00 0x00 0x00`

### YUV422 Conversion

Each pixel (RGB888) converts to 2 bytes of YUV422:
- Even pixels: U + Y
- Odd pixels: V + Y

YCbCr formulas (ITU-R BT.601):
```
Y  = 0.299*R + 0.587*G + 0.114*B
U  = -0.16874*R - 0.33126*G + 0.5*B + 128
V  = 0.5*R - 0.41869*G - 0.08131*B + 128
```

### Frame Rate

- Target: 24 fps (~41.7ms per frame)
- Timing: captured after each frame to maintain consistent rate

## Troubleshooting

| Error                     | Cause / Fix                                              |
|---------------------------|----------------------------------------------------------|
| `LIBUSB_ERROR_ACCESS`     | User lacks USB permission. See "USB Permissions" above.  |
| `LIBUSB_TRANSFER_ERROR`   | Device disconnected or unstable. Unplug and replug.      |
| `Device not found`        | Adapter not connected. Check with `lsusb \| grep 534d`.  |
| Stale image on display    | Run `sudo node index.js` once to reset, then try again.  |
