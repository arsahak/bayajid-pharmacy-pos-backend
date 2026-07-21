const jwt = require("jsonwebtoken");
const OtpCode = require("../model/OtpCode");
const { sendSms } = require("../utils/sms");

const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends per phone
const OTP_TTL_MS = 5 * 60 * 1000; // code valid for 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;

const generateCode = () => String(Math.floor(1000 + Math.random() * 9000));

/**
 * Public: send a 4-digit verification code via SMS to the given phone number.
 */
const requestOtp = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      return res.status(400).json({ message: "Please provide a valid phone number" });
    }

    // Basic rate limiting to avoid SMS cost abuse from rapid resend clicks
    const recentOtp = await OtpCode.findOne({ phone: cleanPhone }).sort({ createdAt: -1 });
    if (recentOtp && Date.now() - recentOtp.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - recentOtp.createdAt.getTime())) / 1000
      );
      return res.status(429).json({ message: `Please wait ${waitSeconds}s before requesting another code.` });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await OtpCode.create({ phone: cleanPhone, code, expiresAt });

    try {
      await sendSms(cleanPhone, `Your Bayajid Pharmacy verification code is ${code}. Valid for 5 minutes.`);
    } catch (smsError) {
      console.error("Failed to send OTP SMS:", smsError.message);
      return res.status(502).json({ message: "Failed to send verification code. Please try again." });
    }

    console.log(`✅ OTP sent to ${cleanPhone}`);
    res.json({ success: true, message: "Verification code sent" });
  } catch (error) {
    console.error("Error requesting OTP:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Public: verify a 4-digit code. On success, returns a short-lived
 * verification token that proves the phone was OTP-verified, required
 * to place an order or recover access.
 */
const verifyOtp = async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ message: "Phone and code are required" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");

    const otpRecord = await OtpCode.findOne({ phone: cleanPhone, verified: false }).sort({
      createdAt: -1,
    });

    if (!otpRecord) {
      return res.status(400).json({ message: "No verification code found. Please request a new one." });
    }

    if (otpRecord.expiresAt < new Date()) {
      return res.status(400).json({ message: "Verification code expired. Please request a new one." });
    }

    if (otpRecord.attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ message: "Too many attempts. Please request a new code." });
    }

    if (otpRecord.code !== String(code).trim()) {
      otpRecord.attempts += 1;
      await otpRecord.save();
      return res.status(400).json({ message: "Incorrect code" });
    }

    otpRecord.verified = true;
    await otpRecord.save();

    const verificationToken = jwt.sign(
      { phone: cleanPhone, purpose: "otp-verified" },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );

    res.json({ success: true, verificationToken });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = { requestOtp, verifyOtp };
