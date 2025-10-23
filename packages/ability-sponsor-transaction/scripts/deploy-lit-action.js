const fs = require('fs');
const path = require('path');
const { of: ipfsOnlyHashOf } = require('ipfs-only-hash');

// Get Pinata JWT from environment variable
const PINATA_JWT = process.env.PINATA_JWT;
if (!PINATA_JWT) {
  throw new Error('PINATA_JWT environment variable is not set in root .env file');
}

(async () => {
  try {
    const outputFile = 'lit-action.js';

    const generatedDir = path.join(__dirname, '../src/generated');
    const filePath = path.join(generatedDir, outputFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Bundled Lit Action code string not found at ${filePath}. Please run pnpm build first.`,
      );
    }
    const litActionCodeString = require(filePath);

    // First compute the IPFS CID locally for the code string
    const expectedCid = await ipfsOnlyHashOf(litActionCodeString.code);

    // Check if this CID is already pinned on Pinata
    const alreadyPinned = await isCidPinned(expectedCid);
    if (alreadyPinned) {
      console.log(`ℹ️  IPFS CID already pinned on Pinata: ${expectedCid}. Skipping upload.`);
      return;
    }

    console.log(`Deploying ${outputFile} to IPFS...`);
    const ipfsCid = await uploadToIPFS(outputFile, litActionCodeString.code);

    const cidJsonPath = path.join(generatedDir, 'vincent-ability-metadata.json');
    const metadata = fs.readFileSync(cidJsonPath);
    const { ipfsCid: metadataIpfsCid } = JSON.parse(metadata);
    if (ipfsCid !== metadataIpfsCid) {
      throw new Error(
        `IPFS CID mismatch in vincent-ability-metadata.json. Expected: ${metadataIpfsCid}, got: ${ipfsCid}`,
      );
    }

    console.log('✅ Successfully deployed Lit Action');
    console.log(`ℹ️  Deployed ${outputFile} to IPFS: ${ipfsCid}`);
  } catch (error) {
    console.error('❌ Error in deploy process:', error);
    process.exit(1);
  }
})();

async function isCidPinned(cid) {
  const url = new URL('https://api.pinata.cloud/data/pinList');
  url.searchParams.set('hashContains', cid);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pinata pinList error ${res.status}: ${text}`);
    }
    const data = await res.json();
    const rows = data?.rows || data?.items || [];
    // Try to find an exact hash match
    return rows.some((r) => r?.ipfs_pin_hash === cid || r?.IpfsHash === cid || r?.hash === cid);
  } catch (e) {
    console.warn(
      'Warning: Failed to check existing Pinata pins. Proceeding to upload.',
      e?.message || e,
    );
    return false;
  }
}

async function uploadToIPFS(filename, fileContent) {
  try {
    const form = new FormData();
    form.append('file', new Blob([fileContent], { type: 'application/javascript' }), filename);

    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
      },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${text}`);
    }

    const data = await response.json();
    return data.IpfsHash;
  } catch (error) {
    console.error('Error uploading to IPFS:', error);
    throw error;
  }
}
