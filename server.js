
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

// Validate JWT secret.
if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET === "replace_this_with_a_long_random_secret" ||
  process.env.JWT_SECRET.includes("PASTE_")
) {
  console.error(
    "Please configure a valid JWT_SECRET in D:\\smart-canteen\\backend\\.env"
  );
  process.exit(1);
}

// CORS configuration.
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:5501",
      "http://127.0.0.1:5501"
    ],
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json());

// Log unexpected request-processing errors.
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check.
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Smart Canteen API is working!"
  });
});

// Get all menu items.
app.get("/api/menu", (req, res) => {
  console.log("Menu request received.");

  db.query(
    "SELECT * FROM menu_items ORDER BY id ASC",
    (err, results) => {
      if (err) {
        console.error("MENU DATABASE ERROR");
        console.error("Error code:", err.code);
        console.error("Error message:", err.message);
        console.error("SQL message:", err.sqlMessage);

        return res.status(500).json({
          success: false,
          message: "Could not load menu.",
          errorCode: err.code || "DATABASE_ERROR"
        });
      }

      console.log(`Menu loaded successfully: ${results.length} items.`);

      return res.json(results);
    }
  );
});

// Create a customer order.
app.post("/api/orders", (req, res) => {
  const { customer_name, items, total_amount } = req.body || {};

  if (
    typeof customer_name !== "string" ||
    !customer_name.trim() ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !Number.isFinite(Number(total_amount)) ||
    Number(total_amount) <= 0
  ) {
    return res.status(400).json({
      message: "Invalid order details."
    });
  }

  const validItems = items.every(
    (item) =>
      item &&
      Number.isInteger(Number(item.id)) &&
      Number(item.id) > 0 &&
      Number.isInteger(Number(item.quantity)) &&
      Number(item.quantity) > 0
  );

  if (!validItems) {
    return res.status(400).json({
      message: "Invalid menu item or quantity."
    });
  }

  db.query(
    "INSERT INTO orders (customer_name, total_amount, status) VALUES (?, ?, ?)",
    [customer_name.trim(), Number(total_amount), "Pending"],
    (err, result) => {
      if (err) {
        console.error("Order creation failed:", err.message);

        return res.status(500).json({
          message: "Could not create order."
        });
      }

      const orderId = result.insertId;

      const orderItems = items.map((item) => [
        orderId,
        Number(item.id),
        Number(item.quantity)
      ]);

      db.query(
        "INSERT INTO order_items (order_id, menu_item_id, quantity) VALUES ?",
        [orderItems],
        (itemErr) => {
          if (itemErr) {
            console.error(
              "Order items creation failed:",
              itemErr.message
            );

            return res.status(500).json({
              message: "Order was created, but its items could not be saved.",
              orderId
            });
          }

          return res.status(201).json({
            success: true,
            message: "Order placed successfully!",
            orderId
          });
        }
      );
    }
  );
});

// Admin login.
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password
  ) {
    return res.status(400).json({
      message: "Enter username and password."
    });
  }

  db.query(
    "SELECT id, username, password_hash FROM admins WHERE username = ? LIMIT 1",
    [username.trim()],
    async (err, results) => {
      if (err) {
        console.error("Admin login database error:", err.message);

        return res.status(500).json({
          message: "Login service unavailable."
        });
      }

      if (results.length === 0) {
        return res.status(401).json({
          message: "Invalid username or password."
        });
      }

      try {
        const admin = results[0];

        const matches = await bcrypt.compare(
          password,
          admin.password_hash
        );

        if (!matches) {
          return res.status(401).json({
            message: "Invalid username or password."
          });
        }

        const token = jwt.sign(
          {
            adminId: admin.id,
            username: admin.username,
            role: "admin"
          },
          process.env.JWT_SECRET,
          { expiresIn: "2h" }
        );

        return res.json({
          success: true,
          message: "Login successful.",
          token
        });
      } catch (error) {
        console.error("Admin login failed:", error.message);

        return res.status(500).json({
          message: "Could not complete login."
        });
      }
    }
  );
});

// Protect admin-only endpoints.
function requireAdmin(req, res, next) {
  const authorization = req.headers.authorization || "";
  const parts = authorization.split(" ");

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer" ||
    !parts[1]
  ) {
    return res.status(401).json({
      message: "Please sign in as admin."
    });
  }

  try {
    const decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );

    if (decoded.role !== "admin" || !decoded.adminId) {
      return res.status(403).json({
        message: "Admin access required."
      });
    }

    req.admin = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      message: "Your session has expired. Please sign in again."
    });
  }
}

// Get orders for the admin dashboard.
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const query = `
    SELECT
      o.id,
      o.customer_name,
      o.total_amount,
      o.status,
      GROUP_CONCAT(
        CONCAT(mi.name, ' x ', oi.quantity)
        SEPARATOR ', '
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    GROUP BY o.id
    ORDER BY o.id DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error("Admin orders query failed:", err.message);

      return res.status(500).json({
        message: "Could not load orders."
      });
    }

    return res.json(results);
  });
});

// Update an order's status.
app.patch(
  "/api/admin/orders/:id/status",
  requireAdmin,
  (req, res) => {
    const orderId = Number(req.params.id);
    const { status } = req.body || {};

    const allowedStatuses = [
      "Pending",
      "Preparing",
      "Ready",
      "Completed",
      "Cancelled"
    ];

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({
        message: "Invalid order ID."
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid order status."
      });
    }

    db.query(
      "UPDATE orders SET status = ? WHERE id = ?",
      [status, orderId],
      (err, result) => {
        if (err) {
          console.error("Order status update failed:", err.message);

          return res.status(500).json({
            message: "Could not update order status."
          });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({
            message: "Order not found."
          });
        }

        return res.json({
          success: true,
          message: "Order status updated successfully."
        });
      }
    );
  }
);

// Handle invalid JSON and other Express errors.
app.use((err, req, res, next) => {
  console.error("Request processing error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(400).json({
    message: "Invalid request."
  });
});

// Start the server.
app.listen(PORT, () => {
  console.log(`Smart Canteen server running at http://localhost:${PORT}`);
});
