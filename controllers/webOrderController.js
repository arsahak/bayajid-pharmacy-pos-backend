const jwt = require("jsonwebtoken");
const WebOrder = require("../model/WebOrder");
const Customer = require("../model/Customer");
const { generateCustomerToken } = require("../midleware/customerAuth");
const { sendSms } = require("../utils/sms");

// Confirms a phone number was OTP-verified via /api/otp/verify within the last 10 minutes
const isPhoneVerified = (verificationToken, phone) => {
  if (!verificationToken) return false;
  try {
    const decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
    return decoded.purpose === "otp-verified" && decoded.phone === String(phone).replace(/\D/g, "");
  } catch {
    return false;
  }
};

/**
 * Public: place a new website order.
 * Requires a verificationToken from a successful /api/otp/verify call.
 * Finds or creates the Customer record by phone, then issues a 1-year access token.
 */
const createWebOrder = async (req, res) => {
  try {
    const { name, phone, address, items, verificationToken } = req.body;

    if (!name || !phone || !address) {
      return res.status(400).json({ message: "Name, phone, and address are required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Order must include at least one item" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      return res.status(400).json({ message: "Please provide a valid phone number" });
    }

    if (!isPhoneVerified(verificationToken, cleanPhone)) {
      return res.status(401).json({ message: "Phone verification required or expired. Please verify again." });
    }

    // Find or create the customer account for this phone number.
    // A verified order also reactivates a previously soft-deleted customer -
    // otherwise they'd get a token from a customer record that customerAuth
    // rejects as inactive on the very next request.
    let customer = await Customer.findOne({ phone: cleanPhone });
    if (customer) {
      customer.name = name;
      customer.isActive = true;
      customer.set("address.street", address);
      await customer.save();
    } else {
      customer = await Customer.create({
        name,
        phone: cleanPhone,
        address: { street: address },
        membershipType: "regular",
        isActive: true,
      });
      console.log(`✅ Customer account created: ${customer.name} (${customer.phone})`);
    }

    const orderItems = items.map((item) => ({
      productId: item.productId || undefined,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      subtotal: item.price * item.quantity,
    }));
    const subtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);

    const orderCount = await WebOrder.countDocuments();
    const orderNo = `WEB-${Date.now()}-${orderCount + 1}`;

    const order = await WebOrder.create({
      orderNo,
      customerId: customer._id,
      customerName: name,
      customerPhone: cleanPhone,
      customerAddress: address,
      items: orderItems,
      subtotal,
      total: subtotal,
    });

    const accessToken = generateCustomerToken(customer._id);

    console.log(`✅ Web order created: ${order.orderNo} for ${customer.name} (${customer.phone})`);

    // Best-effort confirmation SMS to both the customer and the pharmacy owner.
    // The order already succeeded in the DB, so an SMS failure here must not fail the request.
    const ownerPhone = process.env.PHARMACY_OWNER_PHONE;
    const itemsSummary = orderItems.map((item) => `${item.name} x${item.quantity}`).join(", ");

    Promise.allSettled([
      sendSms(
        cleanPhone,
        `Thank you ${name}! Your order ${order.orderNo} (Tk ${subtotal}) has been placed. We'll contact you soon to confirm.`
      ),
      ownerPhone
        ? sendSms(
            ownerPhone,
            `New website order ${order.orderNo} from ${name} (${cleanPhone}). Items: ${itemsSummary}. Total: Tk ${subtotal}. Address: ${address}`
          )
        : Promise.resolve(),
    ]).then((results) => {
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          console.error(`Order confirmation SMS failed (${i === 0 ? "customer" : "owner"}):`, result.reason?.message);
        }
      });
    });

    res.status(201).json({ order, accessToken, customer });
  } catch (error) {
    console.error("Error creating web order:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Public: recover a fresh access token on a new device using the phone number.
 * Requires a verificationToken from a successful /api/otp/verify call.
 */
const requestToken = async (req, res) => {
  try {
    const { phone, verificationToken } = req.body;
    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");

    if (!isPhoneVerified(verificationToken, cleanPhone)) {
      return res.status(401).json({ message: "Phone verification required or expired. Please verify again." });
    }

    const customer = await Customer.findOne({ phone: cleanPhone, isActive: true });

    if (!customer) {
      return res.status(404).json({ message: "No account found for this phone number" });
    }

    const accessToken = generateCustomerToken(customer._id);
    res.json({ accessToken, customer });
  } catch (error) {
    console.error("Error issuing customer token:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Customer (token): list their own order history.
 */
const getMyOrders = async (req, res) => {
  try {
    const orders = await WebOrder.find({ customerId: req.customerId }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Customer (token): get one of their own orders by ID.
 */
const getMyOrderById = async (req, res) => {
  try {
    const order = await WebOrder.findOne({ _id: req.params.id, customerId: req.customerId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json(order);
  } catch (error) {
    console.error("Error fetching customer order:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Staff (admin): list all website orders with search/filter.
 */
const getAllWebOrders = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (search) {
      query.$or = [
        { orderNo: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { customerPhone: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const orders = await WebOrder.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
    const total = await WebOrder.countDocuments(query);

    res.json({
      orders,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching web orders:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Staff (admin): get a single website order by ID.
 */
const getWebOrderById = async (req, res) => {
  try {
    const order = await WebOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json(order);
  } catch (error) {
    console.error("Error fetching web order:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Staff (admin): edit an order's status/notes.
 */
const updateWebOrder = async (req, res) => {
  try {
    const allowedFields = ["status", "notes"];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const order = await WebOrder.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    console.log(`✅ Web order updated: ${order.orderNo} -> ${order.status}`);
    res.json(order);
  } catch (error) {
    console.error("Error updating web order:", error);
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createWebOrder,
  requestToken,
  getMyOrders,
  getMyOrderById,
  getAllWebOrders,
  getWebOrderById,
  updateWebOrder,
};
