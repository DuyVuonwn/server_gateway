const fetch = require('node-fetch'); // Assuming running from a client context, otherwise use native fetch

// Define the existing snapshots
const snapshots = [
  '77edd730693b3d41_1774412821282.jpg',
  '77edd730693b3d41_1774412835872.jpg',
  '77edd730693b3d41_1774412851003.jpg'
];

async function runTest() {
  console.log("Triggering Snapshot Webhooks for device 77edd730693b3d41...");
  
  for (let i = 0; i < snapshots.length; i++) {
    const fileName = snapshots[i];
    
    const payload = {
      type: "device-snapshot",
      eventName: `Test Snapshot ${i + 1}`,
      deviceId: "77edd730693b3d41",
      snapshotPath: `/snapshots/${fileName}`,
      paras: {
        time: new Date().toISOString()
      }
    };

    try {
      // Use native fetch (Node 18+)
      const res = await global.fetch('http://localhost:6060/api/vms/receive-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      console.log(`[+] Sent ${fileName} -> Status: ${res.status}`);
    } catch (err) {
      console.error(`[-] Failed to send: ${err.message}`);
    }
    
    // Wait 2 seconds before sending the next one
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log("Test finished! Check your VMS Dashboard.");
}

runTest();
