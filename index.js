const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
// Load environment variables
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wqymk7z.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();

    const db = client.db("forumDB");
    const usersCollection = db.collection("users");

    const postsCollection = db.collection("posts");
    const paymentsCollection = db.collection("payments");

    // custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authorization) {
        return res.status(401).send({ massage: "unauthorize access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ massage: "unauthorize access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.status(200).send({
          message: "User already exists",
          inserted: false,
        });
      }

      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // ✅ GET posts (with optional email filter)
    app.get("/posts", async (req, res) => {
      try {
        const { email } = req.query;

        let query = {};
        if (email) {
          query = { created_by: email }; // user  filter
        }

        const posts = await postsCollection
          .find(query)
          .sort({ createdAt: -1 }) // latest first
          .toArray();

        res.send(posts);
      } catch (error) {
        console.error("Error fetching posts", error);
        res.status(500).send({ error: "Failed to fetch posts" });
      }
    });

    // ✅ POST new post
    app.post("/posts", async (req, res) => {
      try {
        const newPost = req.body;
        const result = await postsCollection.insertOne(newPost);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to add post" });
      }
    });

    //single post by id
    app.get("/posts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const post = await postsCollection.findOne({ _id: new ObjectId(id) });
        if (!post) return res.status(404).send({ message: "Post not found" });
        res.send(post);
      } catch (error) {
        console.error("Error fetching post:", error);
        res.status(500).send({ error: "Failed to fetch post" });
      }
    });

    // ✅ DELETE post by ID
    app.delete("/posts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const result = await postsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res
            .status(200)
            .send({ success: true, message: "Post deleted successfully" });
        } else {
          res.status(404).send({ success: false, message: "Post not found" });
        }
      } catch (error) {
        console.error("Error deleting post", error);
        res.status(500).send({ error: "Failed to delete post" });
      }
    });

    // POST new comment
    app.post("/posts/:id/comments", async (req, res) => {
      try {
        const id = req.params.id;
        const comment = {
          _id: new ObjectId(), // ✅ must have _id
          text: req.body.text,
          userId: req.body.userId, // ✅ save who posted
          userName: req.body.userName, // ✅ save user name
          createdAt: new Date(),
        };
        await postsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { comments: comment } }
        );
        res.status(200).send({ success: true, comment });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Failed to add comment" });
      }
    });

    // DELETE comment
    app.delete("/posts/:id/comments/:commentId", async (req, res) => {
      try {
        const { id, commentId } = req.params;
        const { userId } = req.body; // ✅ frontend থেকে আসবে

        if (!userId) return res.status(400).send({ error: "userId missing" });

        const post = await postsCollection.findOne({ _id: new ObjectId(id) });
        if (!post) return res.status(404).send({ error: "Post not found" });

        // Find comment
        const comment = post.comments.find(
          (c) => c._id.toString() === commentId
        );

        if (!comment)
          return res.status(404).send({ error: "Comment not found" });

        // Check ownership
        if (comment.userId !== userId)
          return res
            .status(403)
            .send({ error: "You can only delete your own comment" });

        // Delete comment
        await postsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $pull: { comments: { _id: new ObjectId(commentId) } } }
        );

        res.status(200).send({ success: true });
      } catch (error) {
        console.error("Delete comment error:", error);
        res.status(500).send({ error: "Failed to delete comment" });
      }
    });

    // ✅ Vote API
    app.post("/posts/:id/vote", async (req, res) => {
      try {
        const { userId, type } = req.body; // type = "up" বা "down"
        const id = req.params.id;

        const post = await postsCollection.findOne({ _id: new ObjectId(id) });
        if (!post) return res.status(404).send({ message: "Post not found" });

        // Default arrays
        if (!post.voters) post.voters = [];

        // allready vot chaking
        const alreadyVoted = post.voters.find((v) => v.userId === userId);

        if (alreadyVoted) {
          return res
            .status(400)
            .send({ message: "You have already voted on this post." });
        }

        // Update counts
        let updateDoc = {};
        if (type === "up") {
          updateDoc = {
            $inc: { upVote: 1 },
            $push: { voters: { userId, type: "up" } },
          };
        } else if (type === "down") {
          updateDoc = {
            $inc: { downVote: 1 },
            $push: { voters: { userId, type: "down" } },
          };
        } else {
          return res.status(400).send({ message: "Invalid vote type" });
        }

        const result = await postsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        res.send({ success: true, result });
      } catch (error) {
        console.error("Vote error:", error);
        res.status(500).send({ error: "Failed to vote" });
      }
    });

    // 1️⃣ Payment Intent Create API
    app.post("/create-payment-intent", async (req, res) => {
      const { amount, email } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount * 100, // Stripe uses cents
          currency: "usd",
          metadata: { email },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    // 2️⃣ Membership Update API (optional)
    app.post("/membership", async (req, res) => {
      const { email } = req.body;
      try {
        const result = await usersCollection.updateOne(
          { email },
          { $set: { isMember: true } },
          { upsert: true }
        );
        res.send({ success: true, result });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ✅ Save Payment History API

    app.post("/payments", async (req, res) => {
      const payment = req.body; // { email, amount, transactionId, paymentMethod, type, date }
      try {
        const result = await paymentsCollection.insertOne(payment);
        res.send(result);
      } catch (error) {
        console.error("Payment save error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");
  } catch (error) {
    console.error("❌ Error connecting to MongoDB:", error);
  }
}
run().catch(console.dir);

// Basic route
app.get("/", (req, res) => {
  res.send("🚀 Forum Server is running...");
});

// Start server
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
