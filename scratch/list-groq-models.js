async function run() {
  const api_key = process.env.GROQ_API_KEY || "";
  const url = "https://api.groq.com/openai/v1/models";
  const headers = {
      "Authorization": `Bearer ${api_key}`,
      "Content-Type": "application/json"
  };
  try {
    const response = await fetch(url, { headers });
    const data = await response.json();
    const models = (data.data || []).map(m => m.id).sort();
    console.log("=== GROQ MODELS ===");
    models.forEach(id => console.log(id));
  } catch (err) {
    console.error("Error fetching models:", err);
  }
}
run();
