    var firebaseConfig={apiKey:"AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM",authDomain:"lecture-processor-cdff6.firebaseapp.com",projectId:"lecture-processor-cdff6",storageBucket:"lecture-processor-cdff6.firebasestorage.app",messagingSenderId:"374793454161",appId:"1:374793454161:web:c68b21590e9a1fafa32e70"};
    firebase.initializeApp(firebaseConfig);
    var auth=firebase.auth();
    var topbarUtils=window.LectureProcessorTopbar||{};
    var dashboardBtnLabel=document.getElementById('dashboard-btn-label');
    if(topbarUtils.bindAuthCta){
      topbarUtils.bindAuthCta(auth,{
        labelEl:dashboardBtnLabel,
        signedInText:'Dashboard',
        signedOutText:'Sign in'
      });
    }else{
      auth.onAuthStateChanged(function(user){
        dashboardBtnLabel.textContent=user?'Dashboard':'Sign in';
      });
    }
