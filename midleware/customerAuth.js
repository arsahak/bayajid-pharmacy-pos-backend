const jwt = require("jsonwebtoken");
const Customer = require("../model/Customer");

// Verifies the long-lived customer access token issued after a website order/login
const customerAuth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.customerId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const customer = await Customer.findById(decoded.customerId);
    if (!customer || !customer.isActive) {
      return res.status(401).json({ message: "Customer not found or inactive" });
    }

    req.customer = customer;
    req.customerId = customer._id;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

// 1-year access token tied to a Customer record, identified by phone at issue time
const generateCustomerToken = (customerId) => {
  return jwt.sign({ customerId }, process.env.JWT_SECRET, { expiresIn: "365d" });
};

module.exports = { customerAuth, generateCustomerToken };
