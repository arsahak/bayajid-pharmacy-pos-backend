/**
 * BulkSMSBD Utility
 *
 * Sends transactional SMS (used for OTP verification) via the BulkSMSBD API.
 * API docs pattern: GET http://bulksmsbd.net/api/smsapi?api_key=...&type=text&number=...&senderid=...&message=...
 */

const axios = require("axios");

const BULKSMS_URL = "http://bulksmsbd.net/api/smsapi";

// Per BulkSMSBD API docs - response_code meanings
const RESPONSE_CODE_MEANINGS = {
  202: "SMS Submitted Successfully",
  1001: "Invalid Number",
  1002: "Sender ID not correct/sender id is disabled",
  1003: "Please Required all fields/Contact Your System Administrator",
  1005: "Internal Error",
  1006: "Balance Validity Not Available",
  1007: "Balance Insufficient",
  1011: "User Id not found",
  1012: "Masking SMS must be sent in Bengali",
  1013: "Sender Id has not found Gateway by api key",
  1014: "Sender Type Name not found using this sender by api key",
  1015: "Sender Id has not found Any Valid Gateway by api key",
  1016: "Sender Type Name Active Price Info not found by this sender id",
  1017: "Sender Type Name Price Info not found by this sender id",
  1018: "The Owner of this account is disabled",
  1019: "The Sender Type Name Price of this account is disabled",
  1020: "The parent of this account is not found",
  1021: "The parent active Sender Type Name price of this account is not found",
  1031: "Account Not Verified, Please Contact Administrator",
  1032: "IP Not whitelisted - recheck BulkSMSBD API details/IP whitelist",
};

/**
 * Send an SMS via BulkSMSBD
 * @param {String} number - Destination phone number (digits only, e.g. 018XXXXXXXX)
 * @param {String} message - SMS body text
 * @returns {Promise<Object>} Raw API response
 */
const sendSms = async (number, message) => {
  const apiKey = process.env.BULKSMS_API_KEY;
  const senderId = process.env.BULKSMS_SENDER_ID;

  if (!apiKey || !senderId) {
    throw new Error(
      "BULKSMS_API_KEY / BULKSMS_SENDER_ID is not configured in environment variables."
    );
  }

  const response = await axios.get(BULKSMS_URL, {
    params: {
      api_key: apiKey,
      type: "text",
      number,
      senderid: senderId,
      message,
    },
  });

  const data = response.data;

  // BulkSMSBD responds with response_code 202 on success
  const responseCode = typeof data === "object" ? data.response_code : undefined;
  if (responseCode !== undefined && responseCode !== 202) {
    const meaning = RESPONSE_CODE_MEANINGS[responseCode];
    const detail = (typeof data === "object" && (data.error_message || data.success_message)) || "";
    throw new Error(
      `BulkSMSBD error ${responseCode}${meaning ? `: ${meaning}` : ""}${detail ? ` (${detail})` : ""}`
    );
  }

  return data;
};

module.exports = { sendSms };
