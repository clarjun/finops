#!/usr/bin/env node
/**
 * Clear Azure configuration cache and verify it's working
 */

async function clearAzureCache() {
  try {
    console.log('🔄 Clearing Azure configuration cache...\n');
    
    const response = await fetch('http://localhost:5000/api/azure/clear-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Cache cleared successfully');
      console.log(`📊 Azure configured: ${result.isConfigured ? 'YES' : 'NO'}\n`);
      
      if (result.isConfigured) {
        console.log('🎉 Azure is now properly configured!');
        console.log('   You can refresh your dashboard to see Azure data.\n');
      } else {
        console.log('❌ Azure is still not configured.');
        console.log('   Please check your credentials in the Configuration page.\n');
      }
    } else {
      console.error('❌ Failed to clear cache:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\n💡 Make sure the server is running on http://localhost:5000');
  }
}

clearAzureCache();
