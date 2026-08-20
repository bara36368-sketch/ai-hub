# Run AI Hub on Your Phone

## Step 1: Install Termux
Download from F-Droid (NOT Play Store):
https://f-droid.org/en/packages/com.termux/

## Step 2: Setup Termux
Open Termux and run:
```bash
pkg update -y
pkg install -y nodejs git
```

## Step 3: Copy AI Hub to Phone
On your PC, run:
```bash
# Option A: Using ADB (if USB debugging enabled)
adb push C:\Users\ARYASATYA\Desktop\ai-hub /sdcard/ai-hub

# Option B: Using SCP (if SSH server running)
scp -r C:\Users\ARYASATYA\Desktop\ai-hub phone:~/ai-hub

# Option C: Share via WiFi
# Zip the folder and send via WiFi sharing app
```

## Step 4: In Termux
```bash
# Copy from shared storage
cp -r /sdcard/ai-hub/* ~/ai-hub/
cd ~/ai-hub

# Install dependencies
npm install

# Start server
node server.js
```

## Step 5: Access from PC
Open browser: `http://PHONE-IP:8765`

To find your phone IP in Termux:
```bash
ifconfig
# or
ip addr show wlan0
```

## Quick Setup (One-liner)
```bash
pkg install -y nodejs; mkdir -p ~/ai-hub; cd ~/ai-hub; npm install express cors; node server.js
```

## Phone as Server Benefits
- Always on (low power)
- Access from any device on same WiFi
- AI Hub runs on phone CPU
- Chat + Code Editor + Files from phone
