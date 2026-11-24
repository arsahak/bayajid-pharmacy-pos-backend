const Barcode = require("../model/Barcode");
const Product = require("../model/Product");

/**
 * Calculate EAN13 check digit
 */
function calculateCheckDigit(barcode) {
  const digits = barcode.split("").map(Number);
  let sum = 0;

  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Is this barcode already used — in the barcode list, or on a product
 * other than `exceptProductId`?
 */
async function isBarcodeTaken(barcode, exceptProductId) {
  const productQuery = { barcode };
  if (exceptProductId) productQuery._id = { $ne: exceptProductId };
  const [inList, onProduct] = await Promise.all([
    Barcode.exists({ barcode }),
    Product.exists(productQuery),
  ]);
  return !!(inList || onProduct);
}

/**
 * Save `barcode` for `product`: adds it to the barcode list AND writes it to
 * the product's own `barcode` field (the field POS scanning looks up).
 * Any older barcode records of this product are removed, so a product has
 * exactly one barcode.
 */
async function assignBarcodeToProduct({ product, barcode, type, notes, userId }) {
  const newBarcode = await Barcode.create({
    barcode,
    productId: product._id,
    type: type || "EAN13",
    notes,
    createdBy: userId,
  });

  try {
    // updateOne (with timestamps) bumps updatedAt, so the POS catalogue cache picks it up
    await Product.updateOne(
      { _id: product._id },
      { $set: { barcode, ...(userId ? { updatedBy: userId } : {}) } }
    );
  } catch (error) {
    // Keep both places in sync: undo the list entry if the product could not be updated
    await Barcode.deleteOne({ _id: newBarcode._id });
    throw error;
  }

  // Drop this product's previous barcode records
  await Barcode.deleteMany({ productId: product._id, _id: { $ne: newBarcode._id } });

  return newBarcode;
}

/**
 * Generate unique EAN13 barcode
 */
async function generateUniqueEAN13() {
  let barcode;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 100;

  while (!isUnique && attempts < maxAttempts) {
    // Prefix 200-299 for internal use
    const prefix = "200";
    // Generate 9 random digits
    const random = Math.floor(Math.random() * 1000000000)
      .toString()
      .padStart(9, "0");

    const base = prefix + random;
    const checkDigit = calculateCheckDigit(base);
    barcode = base + checkDigit;

    // Must not exist in the barcode list or on any product
    if (!(await isBarcodeTaken(barcode))) {
      isUnique = true;
    }

    attempts++;
  }

  if (!isUnique) {
    throw new Error("Failed to generate unique barcode after maximum attempts");
  }

  return barcode;
}

/**
 * Generate new barcode
 * POST /api/barcodes/generate
 */
exports.generateBarcode = async (req, res) => {
  try {
    // replace: true = give a product that already has a barcode a new one
    const { productId, replace = false } = req.body;

    if (!productId) {
      return res.status(400).json({ message: "Product ID is required" });
    }

    // Validate product exists
    const product = await Product.findById(productId).select("name barcode");
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (product.barcode && !replace) {
      return res.status(409).json({
        message: `This product already has barcode ${product.barcode}`,
        existingBarcode: product.barcode,
      });
    }

    // Generate a unique barcode and save it to the product straight away
    const barcode = await generateUniqueEAN13();
    const saved = await assignBarcodeToProduct({
      product,
      barcode,
      type: "EAN13",
      userId: req.user?._id,
    });

    res.status(201).json({
      _id: saved._id,
      barcode,
      type: "EAN13",
      productId,
      productName: product.name,
      previousBarcode: product.barcode || null,
      saved: true,
    });
  } catch (error) {
    console.error("Generate barcode error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Create new barcode
 * POST /api/barcodes
 */
exports.createBarcode = async (req, res) => {
  try {
    const { barcode, productId, type, notes, replace = false } = req.body;

    // Validate required fields
    if (!barcode || !productId) {
      return res.status(400).json({ message: "Barcode and product ID are required" });
    }

    // Check if product exists
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Check if barcode already exists (in the list or on another product)
    if (await isBarcodeTaken(barcode, product._id)) {
      return res.status(400).json({ message: "Barcode already exists" });
    }

    if (product.barcode && product.barcode !== barcode && !replace) {
      return res.status(409).json({
        message: `This product already has barcode ${product.barcode}`,
        existingBarcode: product.barcode,
      });
    }

    // Save to the barcode list and to the product itself
    const newBarcode = await assignBarcodeToProduct({
      product,
      barcode,
      type,
      notes,
      userId: req.user?._id,
    });

    // Populate product details
    await newBarcode.populate("productId", "name sku price");

    res.status(201).json(newBarcode);
  } catch (error) {
    console.error("Create barcode error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Get all barcodes
 * GET /api/barcodes
 */
exports.getAllBarcodes = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      productId,
      type,
      isActive,
    } = req.query;

    // Build query
    const query = {};

    if (search) {
      query.barcode = { $regex: search, $options: "i" };
    }

    if (productId) {
      query.productId = productId;
    }

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === "true";
    }

    // Execute query with pagination
    const barcodes = await Barcode.find(query)
      .populate("productId", "name sku price image")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    // Get total count
    const count = await Barcode.countDocuments(query);

    res.json({
      barcodes,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      total: count,
    });
  } catch (error) {
    console.error("Get barcodes error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Get barcode by ID
 * GET /api/barcodes/:id
 */
exports.getBarcodeById = async (req, res) => {
  try {
    const { id } = req.params;

    const barcode = await Barcode.findById(id)
      .populate("productId", "name sku price image")
      .populate("createdBy", "name email");

    if (!barcode) {
      return res.status(404).json({ message: "Barcode not found" });
    }

    res.json(barcode);
  } catch (error) {
    console.error("Get barcode error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Delete barcode
 * DELETE /api/barcodes/:id
 */
exports.deleteBarcode = async (req, res) => {
  try {
    const { id } = req.params;

    const barcode = await Barcode.findById(id);
    if (!barcode) {
      return res.status(404).json({ message: "Barcode not found" });
    }

    await Barcode.findByIdAndDelete(id);

    // Remove it from the product too (only if the product still uses this barcode)
    await Product.updateOne(
      { _id: barcode.productId, barcode: barcode.barcode },
      { $unset: { barcode: 1 } }
    );

    res.json({ message: "Barcode deleted successfully" });
  } catch (error) {
    console.error("Delete barcode error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Check if barcode is duplicate
 * POST /api/barcodes/check
 */
exports.checkDuplicate = async (req, res) => {
  try {
    const { barcode } = req.body;

    if (!barcode) {
      return res.status(400).json({ message: "Barcode is required" });
    }

    const existing = await Barcode.findOne({ barcode }).populate(
      "productId",
      "name sku"
    );

    if (existing) {
      return res.json({
        isDuplicate: true,
        existingBarcode: existing,
      });
    }

    res.json({ isDuplicate: false });
  } catch (error) {
    console.error("Check duplicate error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Update barcode (soft delete / deactivate)
 * PATCH /api/barcodes/:id
 */
exports.updateBarcode = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, notes } = req.body;

    const barcode = await Barcode.findById(id);
    if (!barcode) {
      return res.status(404).json({ message: "Barcode not found" });
    }

    if (isActive !== undefined) {
      barcode.isActive = isActive;
    }

    if (notes !== undefined) {
      barcode.notes = notes;
    }

    await barcode.save();
    await barcode.populate("productId", "name sku price");

    res.json(barcode);
  } catch (error) {
    console.error("Update barcode error:", error);
    res.status(500).json({ message: error.message });
  }
};
