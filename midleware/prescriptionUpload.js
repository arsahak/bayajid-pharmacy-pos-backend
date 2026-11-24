const multer = require("multer");

// Prescription files are uploaded to ImgBB, which only stores images.
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"];
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

const MAX_FILE_SIZE_MB = 10;
const MAX_FILES = 5;

const prescriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split(".").pop() || "").toLowerCase();
    // Some phones send HEIC with an empty/odd mimetype, so accept a known extension too
    const typeOk = ALLOWED_MIME_TYPES.includes(file.mimetype) || file.mimetype === "application/octet-stream";
    if (ALLOWED_EXTENSIONS.includes(ext) && typeOk) {
      return cb(null, true);
    }
    cb(new Error("Only image files (JPG, PNG, WEBP, GIF, HEIC) are allowed for prescriptions"));
  },
});

/** Accept up to MAX_FILES files in the "files" field, with readable error messages */
const uploadPrescriptionFiles = (req, res, next) => {
  prescriptionUpload.array("files", MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: `Each prescription file must be ${MAX_FILE_SIZE_MB}MB or smaller` });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ message: `You can upload at most ${MAX_FILES} prescription files at a time` });
      }
    }
    return res.status(400).json({ message: err.message || "File upload error" });
  });
};

module.exports = { uploadPrescriptionFiles, MAX_FILES, MAX_FILE_SIZE_MB };
