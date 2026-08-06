const jwt = require("jsonwebtoken");
const WebOrder = require("../model/WebOrder");
const Customer = require("../model/Customer");
const Product = require("../model/Product");
const Inventory = require("../model/Inventory");
const Store = require("../model/Store");
const Sale = require("../model/Sale");
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

// Same flat-boolean permission pattern used across the other staff controllers
const checkPermission = (user, permission, action = "perform this action") => {
  if (user.role === "super_admin") return null;
  if (!user.permissions || !user.permissions[permission]) {
    return { status: 403, message: `You do not have permission to ${action}` };
  }
  return null;
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
    const permissionError = checkPermission(req.user, "canViewOrders", "view orders");
    if (permissionError) {
      return res.status(permissionError.status).json({ message: permissionError.message });
    }

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
    const permissionError = checkPermission(req.user, "canViewOrders", "view orders");
    if (permissionError) {
      return res.status(permissionError.status).json({ message: permissionError.message });
    }

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
 * Staff (admin): edit an order's notes, or move it between the non-stock-affecting
 * statuses (processing/completed). Use /confirm and /cancel for pending<->confirmed
 * transitions - those are the ones that touch stock and sales.
 */
const updateWebOrder = async (req, res) => {
  try {
    const permissionError = checkPermission(req.user, "canEditOrders", "edit orders");
    if (permissionError) {
      return res.status(permissionError.status).json({ message: permissionError.message });
    }

    const allowedStatuses = ["processing", "completed"];
    const updates = {};
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.status !== undefined) {
      if (!allowedStatuses.includes(req.body.status)) {
        return res.status(400).json({
          message: `Use /confirm or /cancel to set that status. This endpoint only allows: ${allowedStatuses.join(", ")}`,
        });
      }
      updates.status = req.body.status;
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

/**
 * Staff (admin): confirm a pending order.
 * Deducts stock/inventory for each item and creates a "due" Sale record
 * (payment collected on pickup/delivery, matching the POS due-sale flow),
 * all inside a transaction so a partial failure can't leave stock inconsistent.
 */
const confirmWebOrder = async (req, res) => {
  const permissionError = checkPermission(req.user, "canApproveOrders", "confirm orders");
  if (permissionError) {
    return res.status(permissionError.status).json({ message: permissionError.message });
  }

  const session = await WebOrder.startSession();
  session.startTransaction();

  try {
    const order = await WebOrder.findById(req.params.id).session(session);
    if (!order) {
      throw Object.assign(new Error("Order not found"), { status: 404 });
    }
    if (order.status !== "pending") {
      throw Object.assign(new Error(`Only pending orders can be confirmed (current status: ${order.status})`), {
        status: 400,
      });
    }

    const store = await Store.findOne({ isActive: true }).session(session);
    if (!store) {
      throw Object.assign(new Error("No active store found to attribute this sale to"), { status: 400 });
    }

    const saleItems = [];
    for (const item of order.items) {
      if (!item.productId) {
        // Item wasn't linked to a real product record - skip stock/sale line, keep the order data as-is
        continue;
      }

      const product = await Product.findById(item.productId).session(session);
      if (!product) {
        throw Object.assign(new Error(`Product not found for order item "${item.name}"`), { status: 400 });
      }
      if (product.stock < item.quantity) {
        throw Object.assign(
          new Error(`Insufficient stock for ${product.name}. Available: ${product.stock}, Required: ${item.quantity}`),
          { status: 400 }
        );
      }

      product.stock -= item.quantity;
      await product.save({ session });

      const inventory = await Inventory.findOne({ productId: item.productId, storeId: store._id }).session(session);
      if (inventory) {
        if (inventory.quantity < item.quantity) {
          throw Object.assign(new Error(`Insufficient inventory for ${product.name}`), { status: 400 });
        }
        inventory.quantity -= item.quantity;
        await inventory.save({ session });
      }

      saleItems.push({
        productId: item.productId,
        productName: item.name,
        quantity: item.quantity,
        unitPrice: item.price,
        discount: 0,
        tax: 0,
        total: item.subtotal,
      });
    }

    const saleCount = await Sale.countDocuments();
    const saleNo = `SALE-WEB-${Date.now()}-${saleCount}`;

    const [sale] = await Sale.create(
      [
        {
          storeId: store._id,
          saleNo,
          items: saleItems,
          subtotal: order.subtotal,
          discount: order.discountTotal || 0,
          tax: 0,
          total: order.total,
          payments: [{ method: "due", amount: 0 }],
          customerId: order.customerId,
          cashierId: req.userId,
          status: "due",
          dueAmount: order.total,
          notes: `Auto-created from website order ${order.orderNo}`,
        },
      ],
      { session }
    );

    order.status = "confirmed";
    order.saleId = sale._id;
    order.confirmedBy = req.userId;
    order.confirmedAt = new Date();
    await order.save({ session });

    await session.commitTransaction();

    console.log(`✅ Web order confirmed: ${order.orderNo} -> sale ${sale.saleNo}, stock deducted`);
    res.json({ order, sale });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error confirming web order:", error.message);
    res.status(error.status || 500).json({ message: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * Staff (admin): cancel an order.
 * A still-pending order cancels with no side effects. A confirmed/processing
 * order (stock already deducted) has its stock restored and its Sale marked refunded.
 */
const cancelWebOrder = async (req, res) => {
  const permissionError = checkPermission(req.user, "canCancelOrders", "cancel orders");
  if (permissionError) {
    return res.status(permissionError.status).json({ message: permissionError.message });
  }

  const session = await WebOrder.startSession();
  session.startTransaction();

  try {
    const order = await WebOrder.findById(req.params.id).session(session);
    if (!order) {
      throw Object.assign(new Error("Order not found"), { status: 404 });
    }
    if (["completed", "cancelled"].includes(order.status)) {
      throw Object.assign(new Error(`Cannot cancel an order that is already ${order.status}`), { status: 400 });
    }

    const hadStockDeducted = order.status === "confirmed" || order.status === "processing";

    if (hadStockDeducted) {
      const store = await Store.findOne({ isActive: true }).session(session);

      for (const item of order.items) {
        if (!item.productId) continue;

        const product = await Product.findById(item.productId).session(session);
        if (product) {
          product.stock += item.quantity;
          await product.save({ session });
        }

        if (store) {
          const inventory = await Inventory.findOne({ productId: item.productId, storeId: store._id }).session(session);
          if (inventory) {
            inventory.quantity += item.quantity;
            await inventory.save({ session });
          }
        }
      }

      if (order.saleId) {
        await Sale.findByIdAndUpdate(order.saleId, { status: "refunded" }, { session });
      }
    }

    order.status = "cancelled";
    order.cancelledBy = req.userId;
    order.cancelledAt = new Date();
    await order.save({ session });

    await session.commitTransaction();

    console.log(`✅ Web order cancelled: ${order.orderNo}${hadStockDeducted ? " (stock restored)" : ""}`);
    res.json({ order });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error cancelling web order:", error.message);
    res.status(error.status || 500).json({ message: error.message });
  } finally {
    session.endSession();
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
  confirmWebOrder,
  cancelWebOrder,
};
