
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET === "replace_this_with_a_long_random_secret" ||
  process.env.JWT_SECRET.includes("PASTE_")
) {
  console.error("Please configure a valid JWT_SECRET environment variable.");
  process.exit(1);
}

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5501",
  "http://127.0.0.1:5501",
  ...(process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((url) => url.trim())
    : [])
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS."));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Smart Canteen API is working!"
  });
});

app.get("/api/menu", (req, res) => {
  db.query("SELECT * FROM menu_items ORDER BY id ASC", (err, results) => {
    if (err) {
      console.error("Menu database error:", err.code);

      return res.status(500).json({
        success: false,
        message: "Could not load menu."
      });
    }

    return res.json(results);
  });
});

app.post("/api/orders", (req, res) => {
  const { customer_name, items, total_amount } = req.body || {};

  if (
    typeof customer_name !== "string" ||
    !customer_name.trim() ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 50 ||
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
      Number(item.quantity) > 0 &&
      Number(item.quantity) <= 100
  );

  if (!validItems) {
    return res.status(400).json({
      message: "Invalid menu item or quantity."
    });
  }

  const menuIds = [...new Set(items.map((item) => Number(item.id)))];
  const placeholders = menuIds.map(() => "?").join(", ");

  db.query(
    `SELECT id, price FROM menu_items WHERE id IN (${placeholders})`,
    menuIds,
    (menuErr, menuRows) => {
      if (menuErr) {
        console.error("Menu validation failed:", menuErr.code);

        return res.status(500).json({
          message: "Could not validate order items."
        });
      }

      const menuMap = new Map(menuRows.map((item) => [item.id, Number(item.price)]));

      if (menuMap.size !== menuIds.length) {
        return res.status(400).json({
          message: "One or more menu items do not exist."
        });
      }

      const calculatedTotal = items.reduce(
        (sum, item) =>
          sum + menuMap.get(Number(item.id)) * Number(item.quantity),
        0
      );

      if (
        !Number.isFinite(calculatedTotal) ||
        Math.abs(calculatedTotal - Number(total_amount)) > 0.01
      ) {
        return res.status(400).json({
          message: "Order total does not match menu prices."
        });
      }

      db.getConnection((connectionErr, connection) => {
        if (connectionErr) {
          console.error("Order database connection failed.");

          return res.status(500).json({
            message: "Could not place order."
          });
        }

        connection.beginTransaction((transactionErr) => {
          if (transactionErr) {
            connection.release();

            return res.status(500).json({
              message: "Could not start order transaction."
            });
          }

          connection.query(
            "INSERT INTO orders (customer_name, total_amount, status) VALUES (?, ?, ?)",
            [customer_name.trim(), calculatedTotal, "Pending"],
            (orderErr, result) => {
              if (orderErr) {
                return connection.rollback(() => {
                  connection.release();

                  res.status(500).json({
                    message: "Could not create order."
                  });
                });
              }

              const orderItems = items.map((item) => [
                result.insertId,
                Number(item.id),
                Number(item.quantity)
              ]);

              connection.query(
                "INSERT INTO order_items (order_id, menu_item_id, quantity) VALUES ?",
                [orderItems],
                (itemsErr) => {
                  if (itemsErr) {
                    return connection.rollback(() => {
                      connection.release();

                      res.status(500).json({
                        message: "Could not save order items."
                      });
                    });
                  }

                  connection.commit((commitErr) => {
                    if (commitErr) {
                      return connection.rollback(() => {
                        connection.release();

                        res.status(500).json({
                          message: "Could not finalize order."
                        });
                      });
                    }

                    connection.release();

                    return res.status(201).json({
                      success: true,
                      message: "Order placed successfully!",
                      orderId: result.insertId
                    });
                  });
                }
              );
            }
          );
        });
      });
    }
  );
});

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
        console.error("Admin login database error:", err.code);

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
        const matches = await bcrypt.compare(password, admin.password_hash);

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
    const decoded = jwt.verify(parts[1], process.env.JWT_SECRET);

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
      console.error("Admin orders query failed:", err.code);

      return res.status(500).json({
        message: "Could not load orders."
      });
    }

    return res.json(results);
  });
});

app.patch("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
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
        console.error("Order status update failed:", err.code);

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
});

app.use((err, req, res, next) => {
  console.error("Request processing error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(400).json({
    message: "Invalid request."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Smart Canteen API listening on port ${PORT}`);
});
