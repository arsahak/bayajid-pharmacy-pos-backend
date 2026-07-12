/**
 * Cleanup Script: Remove invalid categoryId and subCategoryId fields from products
 *
 * This script removes fields that were accidentally added to products and are not
 * part of the Product schema. These fields can cause issues when fetching products.
 *
 * Run with: node scripts/cleanupProducts.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pos';

async function cleanupProducts() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const productsCollection = db.collection('products');

    // Find products with invalid fields
    const productsWithInvalidFields = await productsCollection.countDocuments({
      $or: [
        { categoryId: { $exists: true } },
        { subCategoryId: { $exists: true } }
      ]
    });

    console.log(`\n📊 Found ${productsWithInvalidFields} products with invalid fields`);

    if (productsWithInvalidFields === 0) {
      console.log('✅ No cleanup needed. All products are clean!');
      await mongoose.disconnect();
      return;
    }

    // Remove invalid fields
    console.log('\n🧹 Cleaning up products...');
    const result = await productsCollection.updateMany(
      {
        $or: [
          { categoryId: { $exists: true } },
          { subCategoryId: { $exists: true } }
        ]
      },
      {
        $unset: {
          categoryId: "",
          subCategoryId: ""
        }
      }
    );

    console.log(`✅ Cleaned ${result.modifiedCount} products`);
    console.log('\n✨ Cleanup completed successfully!');

    // Verify cleanup
    const remainingInvalidProducts = await productsCollection.countDocuments({
      $or: [
        { categoryId: { $exists: true } },
        { subCategoryId: { $exists: true } }
      ]
    });

    if (remainingInvalidProducts === 0) {
      console.log('✅ Verification passed: All invalid fields removed!');
    } else {
      console.log(`⚠️  Warning: ${remainingInvalidProducts} products still have invalid fields`);
    }

    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the cleanup
cleanupProducts();

