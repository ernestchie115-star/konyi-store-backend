require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));

const app = express();

// Simple health check so you can confirm the server is alive
app.get('/', (req, res) => {
  res.send('Konyi Digital Marketing Store backend is running.');
});

// Stripe webhooks must receive the RAW body (not parsed JSON) to verify the signature
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge receipt immediately so Stripe doesn't retry while we work
    res.status(200).json({ received: true });

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      try {
        await handleCompletedCheckout(session);
      } catch (err) {
        console.error('Error handling completed checkout:', err);
        await notifyOwnerOfFailure(session, err);
      }
    }
  }
);

// All other routes can parse JSON normally
app.use(express.json());

async function handleCompletedCheckout(session) {
  const customerEmail =
    session.customer_details?.email || session.customer_email;

  if (!customerEmail) {
    throw new Error(`No customer email found on session ${session.id}`);
  }

  // Get the actual line items (what was purchased) for this checkout session
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 10,
  });

  const attachments = [];
  const titles = [];
  const unmapped = [];

  for (const item of lineItems.data) {
    const priceId = item.price.id;
    const product = products[priceId];

    if (!product) {
      unmapped.push(priceId);
      continue;
    }

    const pdfPath = path.join(__dirname, 'pdfs', product.pdfFile);
    if (!fs.existsSync(pdfPath)) {
      unmapped.push(`${priceId} (file missing: ${product.pdfFile})`);
      continue;
    }

    attachments.push({
      filename: product.pdfFile,
      content: fs.readFileSync(pdfPath).toString('base64'),
    });
    titles.push(product.title);
  }

  if (unmapped.length > 0) {
    // Something was bought that we don't have a PDF mapping for.
    // Don't fail silently - alert the store owner so they can deliver manually.
    await notifyOwnerOfUnmapped(customerEmail, session.id, unmapped);
  }

  if (attachments.length === 0) {
    throw new Error(
      `No deliverable PDFs matched for session ${session.id} (customer: ${customerEmail})`
    );
  }

  await sendPdfEmail(customerEmail, titles, attachments);
  console.log(`Delivered [${titles.join(', ')}] to ${customerEmail}`);
}

async function sendPdfEmail(toEmail, titles, attachments) {
  const bookListHtml = titles.map((t) => `<li>${t}</li>`).join('');

  const { error } = await resend.emails.send({
    from: `Konyi Digital Marketing Store <${process.env.FROM_EMAIL}>`,
    to: toEmail,
    subject: 'Your purchase from Konyi Digital Marketing Store',
    html: `<p>Thank you for your purchase!</p><p>Attached you'll find:</p><ul>${bookListHtml}</ul><p>If you have any trouble opening your file, just reply to this email.</p><p>- Konyi Digital Marketing Store</p>`,
    attachments,
  });

  if (error) {
    throw new Error(`Resend failed to send purchase email: ${JSON.stringify(error)}`);
  }
}

async function notifyOwnerOfUnmapped(customerEmail, sessionId, unmapped) {
  await resend.emails.send({
    from: `Konyi Store Alerts <${process.env.FROM_EMAIL}>`,
    to: process.env.OWNER_EMAIL,
    subject: 'ACTION NEEDED: Unmapped product purchased',
    text: `A customer (${customerEmail}) completed checkout session ${sessionId}, but the following purchased item(s) have no PDF mapping in products.json:\n\n${unmapped.join(
      '\n'
    )}\n\nPlease email the correct PDF to the customer manually, then fix products.json so this doesn't happen again.`,
  });
}

async function notifyOwnerOfFailure(session, err) {
  try {
    await resend.emails.send({
      from: `Konyi Store Alerts <${process.env.FROM_EMAIL}>`,
      to: process.env.OWNER_EMAIL,
      subject: 'ACTION NEEDED: PDF delivery failed',
      text: `Delivery failed for checkout session ${session.id}.\n\nCustomer email (if available): ${
        session.customer_details?.email || session.customer_email || 'unknown'
      }\n\nError: ${err.message}\n\nPlease deliver the PDF manually to this customer.`,
    });
  } catch (notifyErr) {
    console.error('Also failed to send failure-alert email:', notifyErr);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
