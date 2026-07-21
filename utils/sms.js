/**
 * BulkSMSBD Utility
 *
 * Sends transactional SMS (used for OTP verification) via the BulkSMSBD API.
 * API docs pattern: GET http://bulksmsbd.net/api/smsapi?api_key=...&type=text&number=...&senderid=...&message=...
 */

const axios = require("axios");

const BULKSMS_URL = "http://bulksmsbd.net/api/smsapi";

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
    throw new Error(
      (typeof data === "object" && (data.error_message || data.success_message)) ||
        `BulkSMSBD returned response_code ${responseCode}`
    );
  }

  return data;
};

module.exports = { sendSms };
