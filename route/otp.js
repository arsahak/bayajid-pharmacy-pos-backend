const express = require("express");
const router = express.Router();
const otpController = require("../controllers/otpController");

// POST /api/otp/request - Public: send a verification code via SMS
router.post("/request", otpController.requestOtp);

// POST /api/otp/verify - Public: verify the code, returns a short-lived verification token
router.post("/verify", otpController.verifyOtp);

module.exports = router;
