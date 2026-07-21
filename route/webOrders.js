const express = require("express");
const router = express.Router();
const { auth } = require("../midleware/auth");
const { customerAuth } = require("../midleware/customerAuth");
const webOrderController = require("../controllers/webOrderController");

// POST /api/web-orders - Public: place a new order (creates/updates the customer, returns access token)
router.post("/", webOrderController.createWebOrder);

// POST /api/web-orders/auth/token - Public: recover an access token on a new device via phone number
router.post("/auth/token", webOrderController.requestToken);

// GET /api/web-orders/my - Customer (token): list own order history
router.get("/my", customerAuth, webOrderController.getMyOrders);

// GET /api/web-orders/my/:id - Customer (token): view own order detail
router.get("/my/:id", customerAuth, webOrderController.getMyOrderById);

// GET /api/web-orders - Staff: list all website orders
router.get("/", auth, webOrderController.getAllWebOrders);

// GET /api/web-orders/:id - Staff: view any website order
router.get("/:id", auth, webOrderController.getWebOrderById);

// PUT /api/web-orders/:id - Staff: edit order status/notes
router.put("/:id", auth, webOrderController.updateWebOrder);

module.exports = router;
