const Customer = require("../model/Customer");
const { uploadToImageBB } = require("../utils/imagebb");

const IBB_URL_RE = /^https:\/\/i\.ibb\.co\/[A-Za-z0-9]{3,32}\/[^/?#\\]+$/;
const PROXY_BASE = (process.env.IMAGE_PROXY_BASE || "").replace(/\/+$/, "");

/**
 * API responses may rewrite ImgBB URLs to the WebP proxy
 * ("<IMAGE_PROXY_BASE>/img/ibb/<id>/<file>.webp"). When such a URL comes back
 * in an update, store the original ImgBB URL again.
 */
function toOriginalIbbUrl(url) {
  if (typeof url !== "string") return null;
  if (IBB_URL_RE.test(url)) return url;
  if (PROXY_BASE && url.startsWith(`${PROXY_BASE}/img/ibb/`)) {
    const [id, file] = url.slice(`${PROXY_BASE}/img/ibb/`.length).split("/");
    const original = `https://i.ibb.co/${id}/${(file || "").replace(/\.webp$/, "")}`;
    if (IBB_URL_RE.test(original)) return original;
  }
  return null;
}

/** Keep only well-formed prescription entries that point at ImgBB */
function sanitizePrescriptions(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .map((item) => {
      const url = toOriginalIbbUrl(item?.url);
      if (!url) return null;
      return {
        url,
        thumbUrl: toOriginalIbbUrl(item.thumbUrl) || undefined,
        fileName: typeof item.fileName === "string" ? item.fileName.slice(0, 200) : undefined,
        mimeType: typeof item.mimeType === "string" ? item.mimeType.slice(0, 100) : undefined,
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
        uploadedAt: item.uploadedAt ? new Date(item.uploadedAt) : new Date(),
      };
    })
    .filter(Boolean);
}

/**
 * Upload prescription images to ImgBB
 * POST /api/customers/prescriptions  (multipart, field "files")
 */
const uploadPrescriptions = async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "No prescription file uploaded" });
    }

    const uploaded = await Promise.all(
      files.map(async (file) => {
        const result = await uploadToImageBB(file.buffer, file.originalname);
        return {
          url: result.url,
          thumbUrl: result.thumbUrl,
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          uploadedAt: new Date(),
        };
      })
    );

    res.status(201).json({ files: uploaded });
  } catch (error) {
    console.error("Error uploading prescriptions:", error);
    res.status(500).json({ message: error.message || "Failed to upload prescription" });
  }
};

/**
 * Get all customers with search and filter
 */
const getAllCustomers = async (req, res) => {
  try {
    const { q, phone, page = 1, limit = 50 } = req.query;

    // Build query
    const query = { isActive: true };

    // Search by name
    if (q) {
      query.name = { $regex: q, $options: "i" };
    }

    // Search by phone (exact or partial match)
    if (phone) {
      query.phone = { $regex: phone.replace(/\D/g, ""), $options: "i" }; // Remove non-digits for flexible matching
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const customers = await Customer.find(query)
      .limit(parseInt(limit))
      .skip(skip)
      .sort({ createdAt: -1 });

    const total = await Customer.countDocuments(query);

    res.json(customers);
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Find customer by exact phone number
 */
const getCustomerByPhone = async (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, ""); // Remove non-digits

    const customer = await Customer.findOne({
      phone: { $regex: phone, $options: "i" },
      isActive: true,
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (error) {
    console.error("Error finding customer by phone:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Get customer by ID
 */
const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Create new customer
 */
const createCustomer = async (req, res) => {
  try {
    // Check if customer with phone already exists
    if (req.body.phone) {
      const existingCustomer = await Customer.findOne({
        phone: req.body.phone,
        isActive: true,
      });

      if (existingCustomer) {
        return res.status(400).json({
          message: "Customer with this phone number already exists",
          customer: existingCustomer,
        });
      }
    }

    // Set default membership type if not provided
    if (!req.body.membershipType) {
      req.body.membershipType = "regular";
    }

    if (req.body.prescriptions !== undefined) {
      req.body.prescriptions = sanitizePrescriptions(req.body.prescriptions);
    }

    const customer = new Customer(req.body);
    await customer.save();

    console.log(`✅ Customer created: ${customer.name} (${customer.phone})`);

    res.status(201).json(customer);
  } catch (error) {
    console.error("Error creating customer:", error);
    res.status(400).json({ message: error.message });
  }
};

/**
 * Update customer
 */
const updateCustomer = async (req, res) => {
  try {
    if (req.body.prescriptions !== undefined) {
      req.body.prescriptions = sanitizePrescriptions(req.body.prescriptions);
    }

    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    console.log(`✅ Customer updated: ${customer.name}`);

    res.json(customer);
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(400).json({ message: error.message });
  }
};

/**
 * Soft delete customer
 */
const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    console.log(`🗑️ Customer deleted: ${customer.name}`);

    res.json({ message: "Customer deleted successfully", customer });
  } catch (error) {
    console.error("Error deleting customer:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllCustomers,
  getCustomerByPhone,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  uploadPrescriptions,
};

