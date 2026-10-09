const { google } = require('googleapis');

const jsonResponse = (res, statusCode, data) => res.status(statusCode).json(data);

// ☁️ Cloudshare တွင် Folder အသစ်တည်ဆောက်ပေးမည့် Function (ရှိပြီးသားဆိုလျှင် ကျော်သွားမည်)
async function createWebdavFolder(url, authHeader) {
  const response = await fetch(url, {
    method: 'MKCOL',
    headers: { 'Authorization': authHeader }
  });
  // 405 Method Not Allowed ဆိုသည်မှာ Folder ရှိပြီးသားဖြစ်ကြောင်း ပြဆိုသည်
  if (!response.ok && response.status !== 405 && response.status !== 201) {
    throw new Error(`Folder Create Error at ${url}: ${response.status}`);
  }
}

// ☁️ Cloudshare (WebDAV) သို့ ပုံ တင်ပေးမည့် Function
async function uploadToCloudshare(base64Str, mimeType, fileUrl, authHeader) {
  const buffer = Buffer.from(base64Str, 'base64');
  const response = await fetch(fileUrl, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': mimeType || 'image/jpeg'
    },
    body: buffer
  });

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    throw new Error(`Cloudshare Upload Error: ${response.status} ${response.statusText}`);
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let privateKey = process.env.PRIVATE_KEY || '';
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');

    // Sheet ကို စာရင်းသွင်းရန်အတွက် Google API ကို သုံးမည်
    const auth = new google.auth.JWT(
      process.env.CLIENT_EMAIL,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });
    const SHEET_ID = process.env.SHEET_ID_DOORLOCK;

    // Cloudshare Auth Setup
    const username = process.env.CLOUDSHARE_USER || '';
    const password = process.env.CLOUDSHARE_PASSWORD || '';
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    // =========================================================================
    // 🌟 GET REQUEST (Dropdowns & Search)
    // =========================================================================
    if (req.method === 'GET') {
      const { action, date } = req.query;

      if (action === "getOffices") {
        const getOfficeRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: "'Sheet2'!A:B"
        });
        const rows = getOfficeRes.data.values || [];
        let officeList = [], positionList = [];
        for (let r = 0; r < rows.length; r++) {
          if (rows[r][0]) officeList.push(String(rows[r][0]).trim());
          if (rows[r][1]) positionList.push(String(rows[r][1]).trim());
        }
        return jsonResponse(res, 200, { offices: officeList, positions: positionList });
      }

      if (date) {
        const masterRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Sheet2'!A:A" });
        const masterRows = masterRes.data.values || [];
        let masterOffices = [];
        for (let i = 0; i < masterRows.length; i++) {
          if (masterRows[i][0]) masterOffices.push(String(masterRows[i][0]).trim());
        }

        const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Sheet1'!A:F" });
        const dataRows = dataRes.data.values || [];
        let result = [];
        for (let i = 1; i < dataRows.length; i++) {
          let rowDate = dataRows[i][0] ? String(dataRows[i][0]).trim().replace(/'/g, '') : "";
          if (rowDate === date.trim()) {
            result.push({
              date: rowDate,
              name: dataRows[i][1],
              id: dataRows[i][2],
              position: dataRows[i][3],
              office: dataRows[i][4],
              images: dataRows[i][5] ? String(dataRows[i][5]).split(", ") : []
            });
          }
        }
        return jsonResponse(res, 200, { uploaded: result, masterOffices: masterOffices });
      }
      return jsonResponse(res, 200, { status: "active", message: "Vercel + Cloudshare Advanced API Running!" });
    }

    // =========================================================================
    // 🌟 POST REQUEST (Upload to Cloudshare & Save to Sheet)
    // =========================================================================
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
      }

      const { date, name, id, position, office, images } = body;

      // ၁။ Duplicate စစ်ဆေးခြင်း
      const getCheckRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Sheet1'!A:E" });
      const allRows = getCheckRes.data.values || [];
      const startIndex = Math.max(1, allRows.length - 100);

      for (let i = startIndex; i < allRows.length; i++) {
        let rDate = allRows[i][0] ? String(allRows[i][0]).trim().replace(/'/g, '') : "";
        let rPos = allRows[i][3] ? String(allRows[i][3]).trim() : "";
        let rOff = allRows[i][4] ? String(allRows[i][4]).trim() : "";

        if (rDate === date && rPos === position && rOff === office) {
          const errMsg = `❌ ${rPos} က ${name} ကနေပြီးတော့ ${rOff} အတွက်ကို ${rDate} အတွက် တင်ပြီးသွားပါပြီ။`;
          return jsonResponse(res, 200, { status: "duplicate", message: errMsg });
        }
      }

      // ၂။ Date ကိုခွဲခြမ်းစိတ်ဖြာ၍ Folder နာမည်များ တည်ဆောက်ခြင်း
      // Input Date: 2026-10-08
      const dateParts = String(date).split('-');
      const yyyy = dateParts[0]; // 2026
      const mm = parseInt(dateParts[1], 10) - 1; // 9 (Index for Oct)
      const dd = dateParts[2]; // 08
      
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const mmm = months[mm]; // Oct
      const yy = yyyy.slice(2); // 26
      
      const folder1 = yyyy; // 2026
      const folder2 = `${mmm}'${yy}`; // Oct'26
      const folder3 = `${dd} ${mmm} ${yyyy}`; // 08 Oct 2026

      // WebDAV Base URL (သင်တောင်းဆိုထားသော လမ်းကြောင်း)
      const baseWebdavUrl = "https://cloudshare.frontiir.net/remote.php/webdav/SharedOps_Fin/FinOps_MN/Store Door Lock Photo/Lower Door Lock Check/YGN";
      
      // 🌟 Folder များကို အဆင့်လိုက် ဖန်တီးခြင်း (MKCOL)
      const url1 = `${baseWebdavUrl}/${encodeURIComponent(folder1)}`;
      await createWebdavFolder(url1, authHeader);
      
      const url2 = `${url1}/${encodeURIComponent(folder2)}`;
      await createWebdavFolder(url2, authHeader);
      
      const finalFolderUrl = `${url2}/${encodeURIComponent(folder3)}`;
      await createWebdavFolder(finalFolderUrl, authHeader);

      // UI တွင် ပြန်ကြည့်ရန် Cloudshare Browser Link တည်ဆောက်ခြင်း
      const uiBaseDir = `/SharedOps_Fin/FinOps_MN/Store Door Lock Photo/Lower Door Lock Check/YGN/${folder1}/${folder2}/${folder3}`;
      const browserViewLink = `https://cloudshare.frontiir.net/index.php/apps/files/?dir=${encodeURIComponent(uiBaseDir)}`;

      // ၃။ ပုံများကို ဖန်တီးလိုက်သော Final Folder ထဲသို့ Upload တင်ခြင်း (PUT)
      let savedLinks = [];
      if (images && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          let img = images[i];
          let fileName = `DoorLock_${office}_${date}_${i+1}_${Date.now()}.jpg`;
          
          let fileWebdavUrl = `${finalFolderUrl}/${encodeURIComponent(fileName)}`;
          await uploadToCloudshare(img.base64, img.type, fileWebdavUrl, authHeader);
          
          // Sheet ထဲတွင် ပုံနာမည်ကိုသာ မှတ်ထားမည် (သို့မဟုတ်) Browser Link ကို မှတ်မည်
          savedLinks.push(fileName);
        }
      }

      // ၄။ Google Sheet သို့ စာရင်းသွင်းခြင်း (ပုံနာမည်များ နှင့် Folder ကို ဝင်ကြည့်ရန် Link အပါအဝင်)
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "'Sheet1'!A1",
        valueInputOption: 'USER_ENTERED',
        resource: { 
          // Column F တွင် Folder လင့်ခ်ကိုပါ ထည့်သိမ်းပေးမည်
          values: [[`'${date}`, name, id, position, office, browserViewLink]] 
        }
      });

      return jsonResponse(res, 200, { status: "success" });
    }

  } catch (error) {
    return jsonResponse(res, 500, { status: "error", message: error.message || String(error) });
  }
};
