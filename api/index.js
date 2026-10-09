const { google } = require('googleapis');
const { Readable } = require('stream');

const jsonResponse = (res, statusCode, data) => res.status(statusCode).json(data);

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

    // 🌟 Google Sheets နှင့် Google Drive (2) မျိုးလုံးအတွက် Authenticate လုပ်ခြင်း
    const auth = new google.auth.JWT(
      process.env.CLIENT_EMAIL,
      null,
      privateKey,
      [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    );

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    
    // Vercel Environment Variables မှ ယူမည်
    const SHEET_ID = process.env.SHEET_ID_DOORLOCK;
    const FOLDER_ID = process.env.FOLDER_ID;

    // =========================================================================
    // 🌟 GET REQUEST (Dropdowns Load & Dashboard Search)
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
        const masterRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: "'Sheet2'!A:A"
        });
        const masterRows = masterRes.data.values || [];
        let masterOffices = [];
        for (let i = 0; i < masterRows.length; i++) {
          if (masterRows[i][0]) masterOffices.push(String(masterRows[i][0]).trim());
        }

        const dataRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: "'Sheet1'!A:F"
        });
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

      return jsonResponse(res, 200, { status: "active", message: "Door Lock API is Running!" });
    }

    // =========================================================================
    // 🌟 POST REQUEST (Upload Data & Images to Drive)
    // =========================================================================
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
      }

      const { date, name, id, position, office, images } = body;

      // ၁။ Duplicate စစ်ဆေးခြင်း (နောက်ဆုံး Row 100 အတွင်း)
      const getCheckRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "'Sheet1'!A:E"
      });
      const allRows = getCheckRes.data.values || [];
      const startIndex = Math.max(1, allRows.length - 100);

      for (let i = startIndex; i < allRows.length; i++) {
        let rDate = allRows[i][0] ? String(allRows[i][0]).trim().replace(/'/g, '') : "";
        let rName = allRows[i][1] ? String(allRows[i][1]).trim() : "";
        let rPos = allRows[i][3] ? String(allRows[i][3]).trim() : "";
        let rOff = allRows[i][4] ? String(allRows[i][4]).trim() : "";

        if (rDate === date && rPos === position && rOff === office) {
          const errMsg = `❌ ${rPos} က ${rName} ကနေပြီးတော့ ${rOff} အတွက်ကို ${rDate} အတွက် တင်ပြီးသွားပါပြီ။`;
          return jsonResponse(res, 200, { status: "duplicate", message: errMsg });
        }
      }

      // ၂။ ပုံများကို Google Drive သို့ တိုက်ရိုက် Upload တင်ခြင်း
      let imageUrls = [];
      if (images && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          let img = images[i];
          let buffer = Buffer.from(img.base64, 'base64');
          let stream = new Readable();
          stream.push(buffer);
          stream.push(null);

          const fileMetadata = {
            name: `${office}_${date}_${i+1}.jpg`,
            parents: [FOLDER_ID]
          };
          const media = {
            mimeType: 'image/jpeg',
            body: stream
          };

          const driveRes = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
          });

          imageUrls.push(driveRes.data.webViewLink);
        }
      }

      // ၃။ Google Sheet သို့ စာရင်းသွင်းခြင်း
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "'Sheet1'!A1",
        valueInputOption: 'USER_ENTERED',
        resource: { 
          values: [[`'${date}`, name, id, position, office, imageUrls.join(", ")]] 
        }
      });

      return jsonResponse(res, 200, { status: "success" });
    }

  } catch (error) {
    return jsonResponse(res, 500, { status: "error", message: error.message || String(error) });
  }
};
